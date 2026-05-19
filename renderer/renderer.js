// Logique UI : pilotage clavier / manette, mix moteur différentiel, polling
// du capteur ultrason, commandes LED / buzzer, et journal d'événements.

'use strict';

import {
  AURIGA,
  ENCODER_SPEED_MAX,
  GYRO_AXIS,
  frameSetEncoderPwm,
  frameSetEncoderSpeed,
  frameSetDcMotor,
  frameReadUltrasonic,
  frameReadGyro,
  frameReadEncoderSpeed,
  frameSetLed,
  frameTone,
  frameGetVersion,
  frameReset,
  ResponseParser,
} from './makeblock.js';

const api = window.robotApi;

// ---------------------------------------------------------------------------
// Helpers DOM
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const log = (msg, cls = 'info') => {
  const pre = $('#log');
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  line.className = cls;
  line.textContent = `[${time}] ${msg}\n`;
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
  if (pre.childElementCount > 300) pre.removeChild(pre.firstChild);
};

// ---------------------------------------------------------------------------
// État global
// ---------------------------------------------------------------------------

const state = {
  connected: false,
  maxSpeed: 80,          // 0..255 (par defaut : ~70 RPM ~= 11 m/min, vitesse de marche tranquille)
  gpThrottle: 0,         // -1..1, mis a jour chaque frame depuis la manette (0 si stick relache)
  gpTurn: 0,             // -1..1
  gpActive: false,       // true si stick ou DPad sortent de la deadzone
  triggerBoost: 0,       // 0..1 (RT, jusqu'a +70% maxSpeed)
  triggerBrake: 0,       // 0..1 (LT, frein progressif)
  lastM1: 0,
  lastM2: 0,
  lastSendTs: 0,
  invertFwd: false,      // negocie throttle (Z<->S) sans toucher au turn
  invertM1: false,
  invertM2: true,
  swapMotors: false,
  motorMode: 'encSpeed', // par defaut : vitesse boucle fermee = ce que mBlock utilise
  usPort: 10,
  usEnabled: true,
  usDistance: null,      // cm ou null
  autoStopEnabled: false,
  autoStopCm: 15,
  emergencyStop: false,
  gamepadIndex: null,
  txIdx: 1,

  // Gyroscope (degres). gyroZ peut deriver lentement, on stocke un offset.
  gyroX: null, gyroY: null, gyroZ: null,
  yawOffset: 0,

  // Vitesse encodeur (RPM). Convertis en m/min avec le diametre de roue.
  rpmM1: null, rpmM2: null,
  wheelMm: 50, // diametre effectif des poulies 90T du Land Raider (~50 mm)

  // Drunk Driver : turn perturbation injecte par le jeu actif.
  drunkOffset: 0,

  // Heading Hold (PID simple proportionnel sur l'erreur de yaw).
  headingHoldEnabled: false,
  headingKp: 2.0,
  headingFlip: false,
  headingLocked: false,
  headingTarget: 0,

  // Tilt LED.
  tiltLedEnabled: false,
  tiltLedLastSend: 0,

  // Radar de recul : bip-bip et LED rouge synchronises sur la distance.
  backupRadarEnabled: false,
  radarLastBeep: 0,
  radarLedOn: false,
  radarBand: null,    // 'far' | 'mid' | 'close' | 'crit' | null

  // Spin Challenge.
  spinActive: false,
  spinTargetAbs: 0,    // valeur absolue du yaw cible (gyroZ brut)
  spinBestDiff: null,
  spinStableSince: 0,
  spinLastBeep: 0,
};

const TX_IDX_ULTRASONIC = 200;
const TX_IDX_GYRO_X = 201;
const TX_IDX_GYRO_Y = 202;
const TX_IDX_GYRO_Z = 203;
const TX_IDX_ENC_M1 = 204;
const TX_IDX_ENC_M2 = 205;
const RESERVED_IDX = new Set([
  TX_IDX_ULTRASONIC, TX_IDX_GYRO_X, TX_IDX_GYRO_Y, TX_IDX_GYRO_Z,
  TX_IDX_ENC_M1, TX_IDX_ENC_M2,
]);
const nextIdx = () => {
  state.txIdx = (state.txIdx + 1) & 0xff;
  while (RESERVED_IDX.has(state.txIdx) || state.txIdx === 0) {
    state.txIdx = (state.txIdx + 1) & 0xff;
  }
  return state.txIdx;
};

// ---------------------------------------------------------------------------
// Parser série
// ---------------------------------------------------------------------------

const parser = new ResponseParser((resp) => {
  if (typeof resp.value === 'number') {
    switch (resp.idx) {
      case TX_IDX_ULTRASONIC: onUltrasonicReading(resp.value); return;
      case TX_IDX_GYRO_X: state.gyroX = resp.value; return;
      case TX_IDX_GYRO_Y: state.gyroY = resp.value; return;
      case TX_IDX_GYRO_Z: state.gyroZ = resp.value; return;
      case TX_IDX_ENC_M1: state.rpmM1 = resp.value; return;
      case TX_IDX_ENC_M2: state.rpmM2 = resp.value; return;
    }
  }
  if (resp.type === 4) log(`Firmware : ${resp.value}`, 'ok');
});

// ---------------------------------------------------------------------------
// Envoi de trames (sérialise vers le main process)
// ---------------------------------------------------------------------------

async function send(frame) {
  if (!state.connected) return;
  // Le main process accepte un Array ou Uint8Array.
  const res = await api.writeBytes(Array.from(frame));
  if (res && res.ok === false) {
    log(`Écriture KO : ${res.error}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// Connexion série
// ---------------------------------------------------------------------------

async function refreshPorts() {
  const select = $('#portSelect');
  const previous = select.value;
  select.innerHTML = '';
  const ports = await api.listPorts();
  if (Array.isArray(ports)) {
    if (ports.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = '(aucun port détecté)';
      opt.disabled = true;
      select.appendChild(opt);
    }
    for (const p of ports) {
      const opt = document.createElement('option');
      opt.value = p.path;
      const label = [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' — ');
      opt.textContent = label;
      select.appendChild(opt);
    }
    if (previous && ports.find((p) => p.path === previous)) select.value = previous;
  } else if (ports && ports.error) {
    log(`Liste des ports KO : ${ports.error}`, 'err');
  }
}

let connecting = false;
async function connect() {
  if (connecting || state.connected) return;
  connecting = true;
  $('#btnConnect').disabled = true;
  const path = $('#portSelect').value;
  const baudRate = parseInt($('#baudSelect').value, 10);
  if (!path) { log('Aucun port sélectionné', 'err'); connecting = false; $('#btnConnect').disabled = false; return; }
  log(`Ouverture ${path} @ ${baudRate}…`);
  const res = await api.openPort({ path, baudRate });
  if (res.ok) {
    state.connected = true;
    $('#connDot').classList.add('ok');
    $('#connText').textContent = `Connecté · ${path}`;
    $('#btnDisconnect').disabled = false;
    log(`Port ouvert ✓`, 'ok');
    // Reset moteurs + ping version
    await send(frameReset(nextIdx()));
    await send(frameGetVersion(nextIdx()));
  } else {
    log(`Connexion KO : ${res.error}`, 'err');
    if (/access denied|in use/i.test(res.error || '')) {
      log('→ Port déjà ouvert par un autre programme (mBlock, Arduino IDE, autre fenêtre de cette app…). Ferme-le et réessaie.', 'info');
    } else if (/121|timeout|sem/i.test(res.error || '')) {
      log('→ Code 121 = timeout matériel. Si c\'est un port Bluetooth : vérifie que le robot est allumé, à portée, et essaie l\'autre COM (Windows crée toujours 2 ports BT par appareil, l\'un entrant et l\'autre sortant).', 'info');
    }
    $('#btnConnect').disabled = false;
  }
  connecting = false;
}

async function disconnect() {
  if (state.connected) {
    await send(frameReset(nextIdx())); // stop moteurs avant fermeture
    await new Promise((r) => setTimeout(r, 50));
  }
  await api.closePort();
  state.connected = false;
  $('#connDot').classList.remove('ok');
  $('#connText').textContent = 'Déconnecté';
  $('#btnConnect').disabled = false;
  $('#btnDisconnect').disabled = true;
  log('Port fermé');
}

api.onData((bytes) => parser.feed(bytes));
api.onError((msg) => log(`Erreur série : ${msg}`, 'err'));
api.onClosed(() => {
  if (state.connected) {
    state.connected = false;
    $('#connDot').classList.remove('ok');
    $('#connText').textContent = 'Déconnecté';
    $('#btnConnect').disabled = false;
    $('#btnDisconnect').disabled = true;
    log('Port fermé (inattendu)', 'err');
  }
});

// ---------------------------------------------------------------------------
// Clavier
// ---------------------------------------------------------------------------

const pressed = new Set();

function updateKeyHighlight() {
  for (const el of $$('.key')) {
    const k = el.dataset.key;
    const isDown =
      (k === 'z' && pressed.has('z')) ||
      (k === 's' && pressed.has('s')) ||
      (k === 'q' && pressed.has('q')) ||
      (k === 'd' && pressed.has('d')) ||
      (k === 'space' && state.emergencyStop);
    el.classList.toggle('active', isDown);
  }
}

window.addEventListener('keydown', (e) => {
  // Ignore les répétitions
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (['z', 'q', 's', 'd'].includes(k)) {
    pressed.add(k);
    e.preventDefault();
  } else if (k === ' ' || e.code === 'Space') {
    state.emergencyStop = true;
    pressed.clear();
    e.preventDefault();
  } else if (k === '+' || k === '=') {
    setMaxSpeed(state.maxSpeed + 10);
  } else if (k === '-' || k === '_') {
    setMaxSpeed(state.maxSpeed - 10);
  }
  updateKeyHighlight();
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (['z', 'q', 's', 'd'].includes(k)) {
    pressed.delete(k);
  } else if (k === ' ' || e.code === 'Space') {
    state.emergencyStop = false;
  }
  updateKeyHighlight();
});

// Si la fenêtre perd le focus, on relâche tout par sécurité.
window.addEventListener('blur', () => {
  pressed.clear();
  state.emergencyStop = false;
  updateKeyHighlight();
});

// ---------------------------------------------------------------------------
// Manette (Gamepad API)
// ---------------------------------------------------------------------------

function adoptGamepad(gp) {
  if (!gp) return false;
  if (state.gamepadIndex === gp.index) return true;
  state.gamepadIndex = gp.index;
  $('#gpStatus').textContent = `Manette : ${gp.id}`;
  $('#gpStatus').classList.remove('muted');
  log(`Manette détectée : ${gp.id}`, 'ok');
  return true;
}

window.addEventListener('gamepadconnected', (e) => adoptGamepad(e.gamepad));

// Scan permanent : si l'evenement ne s'est pas declenche (l'API exige une
// interaction utilisateur), on detecte la manette des qu'un bouton est pousse.
function scanForGamepad() {
  if (state.gamepadIndex !== null) return;
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) {
    if (gp && gp.connected) { adoptGamepad(gp); return; }
  }
}

window.addEventListener('gamepaddisconnected', (e) => {
  if (state.gamepadIndex === e.gamepad.index) {
    state.gamepadIndex = null;
    // Reset des consignes pour ne pas garder une vitesse fantome.
    state.gpThrottle = 0; state.gpTurn = 0; state.gpActive = false;
    state.triggerBoost = 0; state.triggerBrake = 0;
    prevButtons = [];
    $('#gpStatus').textContent = 'Aucune manette détectée. Clique dans la fenêtre, puis appuie sur un bouton.';
    $('#gpStatus').classList.add('muted');
    log('Manette déconnectée');
  }
});

// Deadzone radiale : on traite (x,y) comme un vecteur 2D — la magnitude
// totale est comparee au seuil, pas chaque axe separement. C'est la pratique
// standard pour Xbox (cf. Apex/CoD). 15% : le hardware Xbox a deja ~7-10% de
// deadzone, on en rajoute juste assez pour absorber le drift typique.
function applyRadialDeadzone(rawX, rawY, dz = 0.15) {
  const mag = Math.hypot(rawX, rawY);
  if (mag < dz) return { x: 0, y: 0, active: false };
  // Rescale lineaire : la magnitude [dz, 1] devient [0, 1] pour conserver
  // toute la course du stick. Direction preservee.
  const scaled = Math.min(1, (mag - dz) / (1 - dz));
  const k = scaled / mag;
  return { x: rawX * k, y: rawY * k, active: true };
}

function applyTriggerDeadzone(v, dz = 0.05) {
  if (v < dz) return 0;
  return (v - dz) / (1 - dz);
}

let prevButtons = []; // pour edge detection
let warnedNonStandard = false;

function pollGamepad() {
  if (state.gamepadIndex === null) return;
  const gp = navigator.getGamepads()[state.gamepadIndex];
  if (!gp) return;

  // Avertir une fois si la manette n'est pas en standard mapping (sinon
  // les boutons sont dans un ordre arbitraire selon le driver).
  if (gp.mapping !== 'standard' && !warnedNonStandard) {
    warnedNonStandard = true;
    log(`Manette en mapping non-standard ("${gp.mapping || 'vide'}") — utilise un driver XInput sous Windows.`, 'err');
  }

  // Stick gauche -> direction.
  const lx = gp.axes[0] || 0;
  const ly = gp.axes[1] || 0;
  const left = applyRadialDeadzone(lx, ly);

  // En standard mapping, LT/RT sont des "boutons" avec un .value 0..1.
  const lt = gp.buttons[6] ? applyTriggerDeadzone(gp.buttons[6].value) : 0;
  const rt = gp.buttons[7] ? applyTriggerDeadzone(gp.buttons[7].value) : 0;

  // DPad = controle digital alternatif (boutons 12-15).
  const dUp    = !!(gp.buttons[12] && gp.buttons[12].pressed);
  const dDown  = !!(gp.buttons[13] && gp.buttons[13].pressed);
  const dLeft  = !!(gp.buttons[14] && gp.buttons[14].pressed);
  const dRight = !!(gp.buttons[15] && gp.buttons[15].pressed);
  const dpadActive = dUp || dDown || dLeft || dRight;

  // CORRECTIF "ne s'arrete pas" : on ECRIT toujours gpThrottle/gpTurn, meme a
  // 0. Quand on lache le stick, l'etat passe a 0 et le fallback clavier prend
  // le relais (et sinon le robot s'arrete).
  if (dpadActive) {
    state.gpThrottle = (dUp ? 1 : 0) - (dDown ? 1 : 0);
    state.gpTurn     = (dRight ? 1 : 0) - (dLeft ? 1 : 0);
    state.gpActive   = true;
  } else if (left.active) {
    state.gpThrottle = -left.y; // axe Y inverse cote navigateur (haut = -1)
    state.gpTurn     = left.x;
    state.gpActive   = true;
  } else {
    state.gpThrottle = 0;
    state.gpTurn     = 0;
    state.gpActive   = false;
  }

  state.triggerBrake = lt; // LT : freine (annule la consigne)
  state.triggerBoost = rt; // RT : boost (jusqu'a +70% maxSpeed)

  $('#gpAxisX').value = state.gpTurn.toFixed(2);
  $('#gpAxisY').value = (-state.gpThrottle).toFixed(2);
  $('#gpTrigger').value = rt.toFixed(2);

  // Boutons avec edge detection.
  const buttons = gp.buttons.map((b) => !!(b && b.pressed));
  const wasPressed = (i) => prevButtons[i] === false && buttons[i] === true;
  // Si un jeu attend des entrees, il consomme les appuis avant les actions par defaut.
  for (let i = 0; i < buttons.length; i++) {
    if (wasPressed(i) && activeGame && activeGame.onButton) {
      const consumed = activeGame.onButton(i);
      if (consumed) { prevButtons = buttons; return; }
    }
  }
  if (wasPressed(0)) send(frameTone(nextIdx(), 880, 120));   // A : klaxon court
  if (wasPressed(1)) { state.emergencyStop = true; setTimeout(() => state.emergencyStop = false, 200); } // B : stop
  if (wasPressed(2)) applyLedColor();                        // X : LED couleur courante
  if (wasPressed(3)) sendLed(0, 0, 0, 0); // Y : LED off
  if (wasPressed(4)) setMaxSpeed(state.maxSpeed - 20);       // LB : vitesse -20
  if (wasPressed(5)) setMaxSpeed(state.maxSpeed + 20);       // RB : vitesse +20
  if (wasPressed(9)) { state.emergencyStop = true; setTimeout(() => state.emergencyStop = false, 200); } // Start : stop alt
  prevButtons = buttons;
}

// ---------------------------------------------------------------------------
// Mix différentiel + envoi moteurs
// ---------------------------------------------------------------------------

function computeMotorTargets() {
  // Priorite : manette active -> manette, sinon clavier. Plus de fuites de
  // valeur entre frames (cf. correctif gpActive).
  let throttle, turn;
  if (state.gpActive) {
    throttle = state.gpThrottle;
    turn = state.gpTurn;
  } else {
    throttle = (pressed.has('z') ? 1 : 0) - (pressed.has('s') ? 1 : 0);
    turn     = (pressed.has('d') ? 1 : 0) - (pressed.has('q') ? 1 : 0);
  }

  if (state.invertFwd) throttle = -throttle;
  // Drunk driver : ajoute une perturbation aleatoire au turn (jeu actif).
  if (state.drunkOffset) turn = clamp(turn + state.drunkOffset, -1, 1);
  // Heading Hold injecte sa correction de turn ici, avant l'echelle.
  turn = applyHeadingHold(throttle, turn);
  if (state.emergencyStop) { throttle = 0; turn = 0; }
  // Frein gachette LT : attenue le mouvement (1.0 = stop complet).
  if (state.triggerBrake) {
    const k = 1 - state.triggerBrake;
    throttle *= k;
    turn *= k;
  }
  // Auto-stop progressif : decroissance lineaire entre (stopAt + 15 cm) et stopAt.
  // En dessous : arret total. Plus de hard-stop brusque ; le robot ralentit avant.
  if (state.autoStopEnabled && state.usDistance !== null && throttle > 0) {
    const d = state.usDistance;
    const stopAt = state.autoStopCm;
    const slowFrom = stopAt + 15;
    if (d <= stopAt) {
      throttle = 0;
    } else if (d < slowFrom) {
      const factor = (d - stopAt) / (slowFrom - stopAt);
      throttle *= factor;
    }
  }

  // Échelle finale (avec boost gâchette RT)
  const scale = state.maxSpeed * (1 + 0.7 * state.triggerBoost); // jusqu'à +70%
  let left = (throttle + turn) * scale;
  let right = (throttle - turn) * scale;

  // Clamp [-255, 255]
  left = Math.max(-255, Math.min(255, left));
  right = Math.max(-255, Math.min(255, right));

  // Mapping vers M1/M2
  let m1 = left, m2 = right;
  if (state.swapMotors) { const t = m1; m1 = m2; m2 = t; }
  if (state.invertM1) m1 = -m1;
  if (state.invertM2) m2 = -m2;

  return { m1: Math.round(m1), m2: Math.round(m2), throttle, turn };
}

// Convertit une consigne PWM-like (-255..255) vers la plage rpm du mode encodeur speed.
// Deux phenomenes pris en compte :
//  1. En dessous de ~MIN_RPM, les moteurs ne bougent pas (frottement statique).
//     On ajoute ce plancher des qu'on demande une consigne non nulle, sinon le
//     slider a un effet binaire ("rien" puis "trop rapide").
//  2. Plage utilisable etiree entre [MIN_RPM, MAX_RPM] pour que chaque cran du
//     slider donne une variation perceptible.
const MIN_MOTION_RPM = 30;
function pwmToRpm(p) {
  if (Math.abs(p) < 1) return 0;
  const sign = Math.sign(p);
  const norm = Math.min(1, Math.abs(p) / 255); // 0..1
  const rpm = MIN_MOTION_RPM + norm * (ENCODER_SPEED_MAX - MIN_MOTION_RPM);
  return sign * Math.round(rpm);
}

function sendMotors(m1, m2) {
  if (state.motorMode === 'encSpeed') {
    const s1 = pwmToRpm(m1), s2 = pwmToRpm(m2);
    send(frameSetEncoderSpeed(nextIdx(), AURIGA.SLOT_M1, s1));
    send(frameSetEncoderSpeed(nextIdx(), AURIGA.SLOT_M2, s2));
  } else if (state.motorMode === 'encPwm') {
    send(frameSetEncoderPwm(nextIdx(), AURIGA.SLOT_M1, m1));
    send(frameSetEncoderPwm(nextIdx(), AURIGA.SLOT_M2, m2));
  } else {
    send(frameSetDcMotor(nextIdx(), AURIGA.MOTOR_M1_PORT, m1));
    send(frameSetDcMotor(nextIdx(), AURIGA.MOTOR_M2_PORT, m2));
  }
}

// ---------------------------------------------------------------------------
// Ultrason
// ---------------------------------------------------------------------------

let lastUsRequest = 0;

function pollUltrasonic(now) {
  if (!state.usEnabled || !state.connected) return;
  if (now - lastUsRequest < 120) return; // ~8 Hz
  lastUsRequest = now;
  // On envoie avec l'IDX réservé pour reconnaître la réponse.
  const frame = frameReadUltrasonic(TX_IDX_ULTRASONIC, state.usPort);
  api.writeBytes(Array.from(frame));
}

function onUltrasonicReading(distCm) {
  // Valeurs aberrantes possibles (0 ou très grandes) selon firmware.
  if (!isFinite(distCm) || distCm < 0 || distCm > 400) {
    state.usDistance = null;
    $('#usValue').value = '— cm';
    $('#usBar').style.width = '0%';
    return;
  }
  state.usDistance = distCm;
  $('#usValue').value = `${distCm.toFixed(1)} cm`;
  const pct = Math.min(100, (distCm / 100) * 100);
  $('#usBar').style.width = `${pct}%`;
}

// ---------------------------------------------------------------------------
// Gyroscope
// ---------------------------------------------------------------------------

function wrapAngle(a) {
  // ramene dans [-180, 180]
  let x = a % 360;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let lastGyroRequest = 0;
let lastEncRequest = 0;

function pollEncoderSpeed(now) {
  if (!state.connected) return;
  if (now - lastEncRequest < 200) return; // 5 Hz suffit pour un affichage
  lastEncRequest = now;
  api.writeBytes(Array.from(frameReadEncoderSpeed(TX_IDX_ENC_M1, AURIGA.SLOT_M1)));
  api.writeBytes(Array.from(frameReadEncoderSpeed(TX_IDX_ENC_M2, AURIGA.SLOT_M2)));
}

// Convertit RPM -> m/min : rpm * pi * D (m).
function rpmToMperMin(rpm) {
  if (rpm == null || !isFinite(rpm)) return null;
  return rpm * Math.PI * (state.wheelMm / 1000);
}

function updateSpeedUI() {
  const v1 = rpmToMperMin(state.rpmM1);
  const v2 = rpmToMperMin(state.rpmM2);
  const fmt = (v) => v == null ? '—' : `${v.toFixed(1)}`;
  $('#speedM1').value = fmt(v1 == null ? null : Math.abs(v1));
  $('#speedM2').value = fmt(v2 == null ? null : Math.abs(v2));
  if (v1 != null && v2 != null) {
    // Pour la moyenne signee : on compare les sens. Si M1 et M2 vont dans
    // le meme sens "robot" (en tenant compte de invertM2 typique), la moyenne
    // de la magnitude reflete la vitesse d'avancement. On reste sur la magnitude
    // pour eviter les pieges d'interpretation.
    const avg = (Math.abs(v1) + Math.abs(v2)) / 2;
    $('#speedAvg').value = avg.toFixed(1);
  } else {
    $('#speedAvg').value = '—';
  }
}

function pollGyro(now) {
  if (!state.connected) return;
  if (now - lastGyroRequest < 100) return; // 10 Hz
  lastGyroRequest = now;
  // 3 axes : la reponse arrive via le parser avec les IDX reserves.
  api.writeBytes(Array.from(frameReadGyro(TX_IDX_GYRO_X, GYRO_AXIS.X)));
  api.writeBytes(Array.from(frameReadGyro(TX_IDX_GYRO_Y, GYRO_AXIS.Y)));
  api.writeBytes(Array.from(frameReadGyro(TX_IDX_GYRO_Z, GYRO_AXIS.Z)));
}

function relativeYaw() {
  if (state.gyroZ === null) return null;
  return wrapAngle(state.gyroZ - state.yawOffset);
}

function updateGyroUI() {
  const pitch = state.gyroX, roll = state.gyroY, yaw = relativeYaw();
  $('#gyroPitch').value = pitch === null ? '—' : pitch.toFixed(1);
  $('#gyroRoll').value  = roll  === null ? '—' : roll.toFixed(1);
  $('#gyroYaw').value   = yaw   === null ? '—' : yaw.toFixed(1);

  // Aiguille de compas : rotation = -yaw (le nord reste en haut quand le robot tourne).
  if (yaw !== null) {
    $('#compassNeedle').setAttribute('transform', `rotate(${-yaw})`);
  }

  // Point d'attitude : (roll, pitch) projete sur le disque, 1 deg = 1.5 px
  // (sature a 60 px = 40 deg).
  const px = clamp((roll || 0) * 1.5, -60, 60);
  const py = clamp((pitch || 0) * 1.5, -60, 60);
  $('#tiltDot').setAttribute('cx', px);
  $('#tiltDot').setAttribute('cy', py);
  const tiltMag = Math.hypot(pitch || 0, roll || 0);
  // Couleur du point : vert -> orange -> rouge selon l'inclinaison.
  let dotFill = '#5cff9e';
  if (tiltMag > 15) dotFill = '#ffa94c';
  if (tiltMag > 30) dotFill = '#ff5c5c';
  $('#tiltDot').setAttribute('fill', dotFill);

  // Detection de basculement : on remonte un evenement utile pour la securite.
  if (tiltMag > 35 && !state.emergencyStop && state.connected) {
    state.emergencyStop = true;
    setTimeout(() => state.emergencyStop = false, 500);
    log(`Basculement detecte (${tiltMag.toFixed(0)}°), stop d'urgence`, 'err');
    send(frameTone(nextIdx(), 1200, 150));
  }
}

// Heading Hold : applique une correction proportionnelle au turn pour maintenir
// le cap pris quand l'utilisateur a commence a avancer.
function applyHeadingHold(throttle, turn) {
  if (!state.headingHoldEnabled || state.gyroZ === null) {
    state.headingLocked = false;
    return turn;
  }
  // L'utilisateur tourne explicitement -> on relache.
  if (Math.abs(turn) > 0.1) {
    state.headingLocked = false;
    return turn;
  }
  // Plus de pousse -> on relache aussi.
  if (Math.abs(throttle) < 0.1) {
    state.headingLocked = false;
    return turn;
  }
  // On verrouille le cap au demarrage.
  if (!state.headingLocked) {
    state.headingLocked = true;
    state.headingTarget = state.gyroZ;
  }
  const err = wrapAngle(state.headingTarget - state.gyroZ);
  const sign = state.headingFlip ? -1 : 1;
  // P controller. err/45 normalise pour qu'a 45 deg d'ecart on demande tout.
  return clamp(err * sign * state.headingKp / 45, -1, 1);
}

// Tilt LED : couleur de l'anneau qui suit l'inclinaison (limite a 5 Hz pour pas
// saturer le canal).
function updateTiltLed(now) {
  if (!state.tiltLedEnabled || !state.connected) return;
  if (state.gyroX === null || state.gyroY === null) return;
  if (now - state.tiltLedLastSend < 200) return;
  state.tiltLedLastSend = now;
  // Hue = direction de l'inclinaison (atan2 roll, pitch), saturation = magnitude.
  const tiltMag = Math.hypot(state.gyroX, state.gyroY);
  const hue = (Math.atan2(state.gyroY, state.gyroX) * 180 / Math.PI + 360) % 360;
  const sat = clamp(tiltMag / 30, 0, 1); // sature a 30 deg
  const { r, g, b } = hslToRgb(hue, sat, 0.5);
  // 0 = toutes les LEDs
  sendLed(0, r, g, b);
}

// Spin Challenge : valeur cible aleatoire, l'utilisateur fait pivoter le robot
// a la main, feedback buzzer + score = meilleur ecart absolu vu pendant 1s.
// Radar de recul : 4 zones distance -> intervalle de bip + LED rouge synchronisee.
// Inspire des capteurs de parking automobile.
const RADAR_BANDS = [
  { name: 'far',   max: 60, interval: 1000, freq: 800,  label: '🟢 obstacle loin' },
  { name: 'mid',   max: 30, interval: 400,  freq: 1000, label: '🟡 proche' },
  { name: 'close', max: 15, interval: 150,  freq: 1300, label: '🟠 très proche' },
  { name: 'crit',  max: 5,  interval: 0,    freq: 1800, label: '🔴 collision !' },
];

function getRadarBand(d) {
  // Distance croissante -> on prend la 1ere zone qui couvre.
  if (d == null || d > 60) return null;
  // Parcours du plus proche au plus loin pour matcher la bonne zone.
  for (let i = RADAR_BANDS.length - 1; i >= 0; i--) {
    if (d <= RADAR_BANDS[i].max) return RADAR_BANDS[i];
  }
  return null;
}

function updateBackupRadar(now) {
  if (!state.backupRadarEnabled || !state.connected) {
    if (state.radarLedOn) {
      sendLed(0, 0, 0, 0);
      state.radarLedOn = false;
      state.radarBand = null;
      $('#radarBand').textContent = '—';
    }
    return;
  }
  const band = getRadarBand(state.usDistance);
  if (state.radarBand !== (band ? band.name : null)) {
    state.radarBand = band ? band.name : null;
    $('#radarBand').textContent = band ? band.label : '—';
  }
  if (!band) {
    // Hors zone : eteint la LED si elle etait allumee.
    if (state.radarLedOn) {
      sendLed(0, 0, 0, 0);
      state.radarLedOn = false;
    }
    return;
  }
  // Zone critique : LED rouge fixe + tonalite plus longue.
  if (band.interval === 0) {
    if (!state.radarLedOn || now - state.radarLastBeep > 400) {
      sendLed(0, 255, 0, 0);
      state.radarLedOn = true;
      send(frameTone(nextIdx(), band.freq, 350));
      state.radarLastBeep = now;
    }
    return;
  }
  // Zones intermediaires : flash rouge sync avec un bip court.
  if (now - state.radarLastBeep >= band.interval) {
    state.radarLastBeep = now;
    sendLed(0, 255, 0, 0);
    state.radarLedOn = true;
    const beepDur = Math.min(80, band.interval / 3);
    send(frameTone(nextIdx(), band.freq, beepDur));
    // Eteint la LED apres la duree du bip pour creer l'effet flash.
    setTimeout(() => {
      if (state.backupRadarEnabled && state.radarBand === band.name) {
        sendLed(0, 0, 0, 0);
        state.radarLedOn = false;
      }
    }, beepDur + 20);
  }
}

function startSpinChallenge() {
  if (state.gyroZ === null) { log('Gyroscope pas encore pret', 'err'); return; }
  const offset = 60 + Math.random() * 240; // 60..300 deg
  const direction = Math.random() < 0.5 ? -1 : 1;
  state.spinActive = true;
  state.spinTargetAbs = state.gyroZ + direction * offset;
  state.spinBestDiff = 9999;
  state.spinStableSince = 0;
  $('#spinTarget').value = (direction * offset).toFixed(0);
  $('#spinScore').value = '—';
  $('#spinHint').textContent = direction > 0 ? '↻ Tourne dans le sens horaire' : '↺ Sens anti-horaire';
  log(`Spin Challenge: ${(direction * offset).toFixed(0)}° demandes`, 'ok');
}

function updateSpinChallenge(now) {
  if (!state.spinActive || state.gyroZ === null) return;
  const diff = wrapAngle(state.spinTargetAbs - state.gyroZ);
  $('#spinDiff').value = diff.toFixed(1);
  const absDiff = Math.abs(diff);
  if (absDiff < state.spinBestDiff) state.spinBestDiff = absDiff;

  // Beeps de proximite : intervalle decroit de 600 ms (loin) a 50 ms (tout proche).
  const beepInterval = clamp(50 + absDiff * 5, 50, 600);
  if (now - state.spinLastBeep > beepInterval) {
    state.spinLastBeep = now;
    if (absDiff < 60) {
      const freq = 400 + Math.round((60 - absDiff) * 12); // plus aigu quand on s'approche
      send(frameTone(nextIdx(), freq, 40));
    }
  }

  // Succes : moins de 5° d'ecart pendant 800 ms.
  if (absDiff < 5) {
    if (!state.spinStableSince) state.spinStableSince = now;
    if (now - state.spinStableSince > 800) {
      state.spinActive = false;
      const score = Math.max(0, Math.round(100 - state.spinBestDiff * 2));
      $('#spinScore').value = score;
      $('#spinHint').textContent = `🏆 Score : ${score}/100`;
      log(`Spin Challenge reussi, score ${score}`, 'ok');
      // Petite fanfare
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => setTimeout(() => send(frameTone(nextIdx(), f, 120)), i * 130));
    }
  } else {
    state.spinStableSince = 0;
  }
}

// ---------------------------------------------------------------------------
// LEDs
// ---------------------------------------------------------------------------

// Le firmware Auriga a un bug "feature" : la premiere commande sur l'anneau
// onboard (port=0, slot=2) appelle juste setpin() puis break, sans appliquer la
// couleur. Il faut envoyer 2 trames pour que la couleur passe. On en envoie
// systematiquement 2 — c'est idempotent et evite tout etat a tracker.
function sendLed(ledIdx, r, g, b) {
  const f = () => frameSetLed(nextIdx(), AURIGA.ONBOARD_LED_RING_PORT, AURIGA.ONBOARD_LED_RING_SLOT, ledIdx, r, g, b);
  send(f());
  send(f());
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function applyLedColor() {
  const idx = parseInt($('#ledIndex').value, 10);
  const { r, g, b } = hexToRgb($('#ledColor').value);
  sendLed(idx, r, g, b);
}

async function ledRainbow() {
  // 12 LEDs, couleurs HSL réparties
  for (let i = 1; i <= 12; i++) {
    const hue = ((i - 1) / 12) * 360;
    const { r, g, b } = hslToRgb(hue, 1, 0.5);
    sendLed(i, r, g, b);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

// ---------------------------------------------------------------------------
// Buzzer
// ---------------------------------------------------------------------------

function playTone(freq, dur) {
  send(frameTone(nextIdx(), freq, dur));
}

async function playSiren() {
  for (let f = 400; f <= 1200; f += 100) {
    playTone(f, 90);
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let f = 1200; f >= 400; f -= 100) {
    playTone(f, 90);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ===========================================================================
// JEUX & MELODIES
// ===========================================================================
//
// Mélodies 8-bit jouées au buzzer monophonique. Format : [freq Hz, duration ms].
// freq=0 = silence. Notes raccourcies pour le buzzer Auriga qui bloque la
// boucle principale pendant chaque tone. Sources : robsoncouto/arduino-songs.
const MELODIES = {
  mario: { name: 'Mario theme', notes: [
    [659,120],[659,120],[0,120],[659,120],[0,120],[523,120],[659,120],[0,120],
    [784,120],[0,360],[392,120],[0,360],
    [523,120],[0,180],[392,120],[0,180],[330,120],[0,180],
    [440,120],[0,90],[494,120],[0,90],[466,120],[0,60],[440,120],[0,180],
    [392,120],[659,120],[784,120],[880,120],[0,90],[698,120],[784,120],[0,90],[659,120],
  ]},
  tetris: { name: 'Tetris A', notes: [
    [659,220],[494,110],[523,110],[587,220],[523,110],[494,110],
    [440,220],[440,110],[523,110],[659,220],[587,110],[523,110],
    [494,330],[523,110],[587,220],[659,220],
    [523,220],[440,220],[440,220],[0,110],
    [587,220],[698,110],[880,220],[784,110],[698,110],
    [659,330],[523,110],[659,220],[587,110],[523,110],
    [494,220],[494,110],[523,110],[587,220],[659,220],
    [523,220],[440,220],[440,220],
  ]},
  imperial: { name: 'Imperial March', notes: [
    [440,500],[440,500],[440,500],[349,350],[523,150],
    [440,500],[349,350],[523,150],[440,650],[0,150],
    [659,500],[659,500],[659,500],[698,350],[523,150],
    [415,500],[349,350],[523,150],[440,650],
  ]},
  zelda: { name: 'Zelda lullaby', notes: [
    [659,600],[494,200],[523,400],[659,200],[523,200],
    [659,200],[988,800],[0,200],[587,800],
    [659,600],[494,200],[523,400],[659,200],[523,200],
    [659,200],[988,800],
  ]},
  pacman: { name: 'Pacman intro', notes: [
    [494,125],[988,125],[740,125],[622,125],[988,60],[740,180],[622,250],
    [466,125],[932,125],[698,125],[587,125],[932,60],[698,180],[587,250],
    [494,125],[988,125],[740,125],[622,125],[988,60],[740,180],[622,250],
    [622,150],[698,150],[740,180],[740,180],[784,180],[831,180],[880,400],
  ]},
  hedwig: { name: "Hedwig's theme", notes: [
    [494,500],[659,250],[698,375],[659,250],[988,500],[880,750],
    [659,500],[698,375],[659,250],[622,500],[698,250],[494,750],
    [494,500],[659,250],[698,375],[659,250],[988,500],[1175,500],[1109,250],
    [1047,500],[831,250],[1047,375],[988,250],[932,500],[554,250],[988,750],
  ]},
  megalovania: { name: 'Megalovania', notes: [
    [294,125],[294,125],[587,250],[440,375],[0,125],
    [415,250],[392,250],[349,250],[294,125],[349,125],[392,125],
    [262,125],[262,125],[587,250],[440,375],[0,125],
    [415,250],[392,250],[349,250],[294,125],[349,125],[392,125],
    [233,125],[233,125],[587,250],[440,375],[0,125],
    [415,250],[392,250],[349,250],[294,125],[349,125],[392,125],
  ]},
  sonic: { name: 'Sonic theme (intro)', notes: [
    [659,150],[784,150],[988,150],[1175,300],[0,75],
    [988,150],[1175,300],[0,150],
    [880,150],[988,150],[1047,150],[988,300],[880,300],
    [784,300],[0,150],
    [659,150],[784,150],[988,150],[1175,300],
  ]},
};

const JINGLES = {
  win:     [[659,100],[784,100],[988,100],[1319,250]],
  lose:    [[330,200],[262,200],[196,500]],
  levelUp: [[440,80],[554,80],[659,80],[880,250]],
  ready:   [[440,80],[0,120],[440,80],[0,120],[880,250]],
  bip:     [[800,60]],
  coin:    [[988,80],[1319,300]],
};

let melodyTimers = [];
function stopAllMusic() {
  melodyTimers.forEach(clearTimeout);
  melodyTimers = [];
}

function playMelody(notes, opts = {}) {
  stopAllMusic();
  if (!state.connected) return Promise.resolve();
  let t = 0;
  for (const [freq, dur] of notes) {
    const id = setTimeout(() => {
      if (freq > 0) send(frameTone(nextIdx(), freq, dur));
      if (opts.onNote) opts.onNote(freq, dur);
    }, t);
    melodyTimers.push(id);
    t += dur + 30; // pause inter-notes courte
  }
  return new Promise((res) => {
    melodyTimers.push(setTimeout(res, t));
  });
}

// ---------------------------------------------------------------------------
// Moteur de jeux
// ---------------------------------------------------------------------------

let activeGame = null;

function setGameStatus(text) { $('#gameStatus').textContent = text; }

function startGame(name) {
  stopActiveGame();
  const g = GAMES[name];
  if (!g) return;
  activeGame = g;
  setGameStatus(`▶ ${g.label || name} démarré`);
  g.start();
}

function stopActiveGame() {
  if (activeGame && activeGame.stop) activeGame.stop();
  activeGame = null;
  stopAllMusic();
  state.drunkOffset = 0;
  if (state.connected) sendLed(0, 0, 0, 0);
}

const GAMES = {
  // ----- 1. JUKEBOX -----
  jukebox: {
    label: '🎵 Jukebox',
    start() {
      const name = $('#melodySelect').value;
      const m = MELODIES[name];
      if (!m) return;
      setGameStatus(`🎵 Lecture : ${m.name}`);
      const colorsByHz = (f) => {
        const hue = (f * 0.5) % 360;
        return hslToRgb(hue, 1, 0.5);
      };
      playMelody(m.notes, {
        onNote: (f) => {
          if (f === 0) return;
          const { r, g, b } = colorsByHz(f);
          sendLed(0, r, g, b);
        },
      }).then(() => {
        if (activeGame === this) {
          setGameStatus(`✅ Fin : ${m.name}`);
          sendLed(0, 0, 0, 0);
        }
      });
    },
    stop() { stopAllMusic(); },
    tick() {},
  },

  // ----- 2. SIMON DIT -----
  simon: {
    label: '🎨 Simon dit',
    sequence: [],
    userStep: 0,
    accepting: false,
    start() {
      this.sequence = [];
      this.userStep = 0;
      this.accepting = false;
      this.nextRound();
    },
    stop() { this.accepting = false; stopAllMusic(); },
    tick() {},
    SIMON_COLORS: [
      { name: 'Rouge',  r: 255, g: 0,   b: 0,   freq: 330, btn: 0 }, // A
      { name: 'Vert',   r: 0,   g: 255, b: 0,   freq: 440, btn: 1 }, // B
      { name: 'Bleu',   r: 0,   g: 80,  b: 255, freq: 523, btn: 2 }, // X
      { name: 'Jaune',  r: 255, g: 220, b: 0,   freq: 659, btn: 3 }, // Y
    ],
    async nextRound() {
      this.sequence.push(Math.floor(Math.random() * 4));
      this.accepting = false;
      setGameStatus(`👀 Niveau ${this.sequence.length} — observe…`);
      await new Promise((r) => setTimeout(r, 500));
      for (const idx of this.sequence) {
        if (activeGame !== this) return;
        const c = this.SIMON_COLORS[idx];
        sendLed(0, c.r, c.g, c.b);
        send(frameTone(nextIdx(), c.freq, 280));
        await new Promise((r) => setTimeout(r, 400));
        sendLed(0, 0, 0, 0);
        await new Promise((r) => setTimeout(r, 120));
      }
      this.userStep = 0;
      this.accepting = true;
      setGameStatus(`🎮 A/B/X/Y — reproduis ${this.sequence.length} couleur(s)`);
    },
    onButton(i) {
      if (!this.accepting) return true; // bloque pendant la demo
      const idx = this.SIMON_COLORS.findIndex((c) => c.btn === i);
      if (idx === -1) return false;
      const c = this.SIMON_COLORS[idx];
      sendLed(0, c.r, c.g, c.b);
      send(frameTone(nextIdx(), c.freq, 200));
      setTimeout(() => { if (activeGame === this) sendLed(0, 0, 0, 0); }, 220);
      if (idx === this.sequence[this.userStep]) {
        this.userStep++;
        if (this.userStep === this.sequence.length) {
          this.accepting = false;
          setTimeout(() => playMelody(JINGLES.levelUp), 300);
          setTimeout(() => this.nextRound(), 1200);
        }
      } else {
        this.accepting = false;
        setGameStatus(`💀 Game Over — score ${this.sequence.length - 1}`);
        playMelody(JINGLES.lose);
      }
      return true;
    },
  },

  // ----- 3. REACTION TIME -----
  reaction: {
    label: '⚡ Reaction time',
    phase: 'idle',
    startTime: 0,
    timer: null,
    start() {
      this.phase = 'waiting';
      setGameStatus('🟠 Attends le flash vert…');
      sendLed(0, 255, 100, 0);
      this.timer = setTimeout(() => {
        if (activeGame !== this) return;
        this.phase = 'go';
        this.startTime = performance.now();
        sendLed(0, 0, 255, 0);
        send(frameTone(nextIdx(), 1200, 80));
        setGameStatus('🟢 GO ! Appuie A !');
      }, 1500 + Math.random() * 4000);
    },
    stop() { clearTimeout(this.timer); },
    tick() {},
    onButton(i) {
      if (i !== 0) return false;
      if (this.phase === 'waiting') {
        clearTimeout(this.timer);
        setGameStatus('🚫 Faux départ !');
        sendLed(0, 255, 0, 0);
        playMelody(JINGLES.lose);
        this.phase = 'done';
      } else if (this.phase === 'go') {
        const t = performance.now() - this.startTime;
        let rank = '🐌 lent';
        if (t < 200) rank = '⚡ ninja';
        else if (t < 300) rank = '🚀 rapide';
        else if (t < 450) rank = '👍 correct';
        setGameStatus(`${rank} — ${t.toFixed(0)} ms`);
        playMelody(t < 300 ? JINGLES.win : JINGLES.bip);
        this.phase = 'done';
      }
      return true;
    },
  },

  // ----- 4. DEVINE LA DISTANCE -----
  distance: {
    label: '📏 Devine la distance',
    target: 0,
    start() {
      this.target = 10 + Math.floor(Math.random() * 80); // 10..90 cm
      setGameStatus(`🎯 Place le robot pile à ${this.target} cm d'un mur, puis appuie A.`);
    },
    stop() {},
    tick() {},
    onButton(i) {
      if (i !== 0) return false;
      if (state.usDistance == null) {
        setGameStatus('❌ Pas de lecture ultrason (active "Lire en continu")');
        return true;
      }
      const measured = state.usDistance;
      const diff = Math.abs(measured - this.target);
      const score = Math.max(0, 100 - Math.round(diff * 4));
      setGameStatus(`📏 ${measured.toFixed(1)} cm (cible ${this.target}) → écart ${diff.toFixed(1)} cm · ${score}/100`);
      playMelody(diff < 3 ? JINGLES.win : (diff < 10 ? JINGLES.coin : JINGLES.bip));
      return true;
    },
  },

  // ----- 5. ROULE AU PIFOMETRE -----
  encoder: {
    label: '🛞 Roule au pifomètre',
    target: 0,
    distance: 0,
    driving: false,
    lastT: 0,
    start() {
      this.target = (30 + Math.random() * 270) / 100; // 0.30..3.00 m
      this.distance = 0;
      this.driving = false;
      setGameStatus(`🛞 Cible ${this.target.toFixed(2)} m — appuie A pour partir, A à nouveau pour stopper.`);
    },
    stop() { this.driving = false; },
    tick(now) {
      if (!this.driving) return;
      const dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (state.rpmM1 != null && state.rpmM2 != null) {
        const D = state.wheelMm / 1000;
        const v1 = Math.abs(state.rpmM1) * Math.PI * D / 60;
        const v2 = Math.abs(state.rpmM2) * Math.PI * D / 60;
        this.distance += ((v1 + v2) / 2) * dt;
      }
      setGameStatus(`🛞 Cible ${this.target.toFixed(2)} m — parcouru ${this.distance.toFixed(2)} m`);
    },
    onButton(i) {
      if (i !== 0) return false;
      if (!this.driving) {
        this.driving = true;
        this.lastT = performance.now();
        this.distance = 0;
        setGameStatus(`🛞 GO ! Conduis et appuie A pour t'arrêter.`);
      } else {
        this.driving = false;
        const diff = Math.abs(this.distance - this.target);
        const score = Math.max(0, 100 - Math.round(diff * 30));
        setGameStatus(`🛞 ${this.distance.toFixed(2)} m / cible ${this.target.toFixed(2)} → écart ${(diff*100).toFixed(0)} cm · ${score}/100`);
        playMelody(diff < 0.1 ? JINGLES.win : (diff < 0.3 ? JINGLES.coin : JINGLES.bip));
      }
      return true;
    },
  },

  // ----- 6. DRUNK DRIVER -----
  drunk: {
    label: '🥴 Drunk driver',
    startYaw: 0, totalDrift: 0, endTime: 0,
    nextHic: 0, hicUntil: 0, lastT: 0,
    start() {
      if (state.gyroZ == null) { setGameStatus('Gyro pas prêt'); return; }
      this.startYaw = state.gyroZ;
      this.totalDrift = 0;
      this.endTime = performance.now() + 30000;
      this.nextHic = performance.now() + 2000;
      this.hicUntil = 0;
      this.lastT = performance.now();
      state.drunkOffset = 0;
      setGameStatus('🥴 30 s pour rouler droit malgré les hick !');
    },
    stop() { state.drunkOffset = 0; },
    tick(now) {
      const dt = (now - this.lastT) / 1000;
      this.lastT = now;
      if (state.gyroZ != null) {
        const drift = Math.abs(wrapAngle(state.gyroZ - this.startYaw));
        this.totalDrift += drift * dt; // drift cumulé en deg·s
      }
      if (now > this.nextHic) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        state.drunkOffset = dir * (0.3 + Math.random() * 0.4);
        this.hicUntil = now + 400;
        this.nextHic = now + 2200 + Math.random() * 2000;
        send(frameTone(nextIdx(), 80 + Math.random() * 120, 120));
      }
      if (now >= this.hicUntil) state.drunkOffset = 0;
      const remaining = Math.max(0, (this.endTime - now) / 1000);
      setGameStatus(`🥴 ${remaining.toFixed(1)} s — drift cumulé ${this.totalDrift.toFixed(0)} deg·s`);
      if (now >= this.endTime) {
        state.drunkOffset = 0;
        const score = Math.max(0, 1000 - Math.round(this.totalDrift));
        setGameStatus(`🥴 Fin ! Drift ${this.totalDrift.toFixed(0)} → score ${score}/1000`);
        playMelody(this.totalDrift < 300 ? JINGLES.win : JINGLES.lose);
        activeGame = null;
      }
    },
  },

  // ----- 7. LIMBO -----
  limbo: {
    label: '🤸 Limbo',
    level: 1, target: 15, inZoneSince: 0,
    start() {
      this.level = 1;
      this.target = 15;
      this.inZoneSince = 0;
      setGameStatus(`🤸 N1 — penche le robot à ${this.target}° (axe X). Tiens 2 s.`);
    },
    stop() {},
    tick(now) {
      if (state.gyroX == null) return;
      const diff = Math.abs(state.gyroX - this.target);
      if (diff < 5) {
        if (!this.inZoneSince) this.inZoneSince = now;
        const held = (now - this.inZoneSince) / 1000;
        setGameStatus(`🤸 N${this.level} : ${state.gyroX.toFixed(0)}° · cible ${this.target}° · stable ${held.toFixed(1)}/2 s`);
        if (held >= 2) {
          playMelody(JINGLES.levelUp);
          this.level++;
          this.target += 8 + Math.round(Math.random() * 6);
          this.inZoneSince = 0;
          setGameStatus(`🎉 N${this.level} : cible ${this.target}°.`);
        }
      } else {
        this.inZoneSince = 0;
        setGameStatus(`🤸 N${this.level} : ${state.gyroX.toFixed(0)}° · cible ${this.target}° · hors zone`);
      }
    },
  },

  // ----- 8. YAW RUSH (whack-a-mole rotatif) -----
  yawrush: {
    label: '🎯 Yaw Rush',
    active: false, endTime: 0, target: 0, inZoneSince: 0, score: 0,
    start() {
      if (state.gyroZ == null) { setGameStatus('Gyro pas prêt'); return; }
      this.active = true;
      this.endTime = performance.now() + 30000;
      this.target = state.gyroZ + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 120);
      this.inZoneSince = 0;
      this.score = 0;
    },
    stop() { this.active = false; },
    tick(now) {
      if (!this.active || state.gyroZ == null) return;
      const remaining = (this.endTime - now) / 1000;
      if (remaining <= 0) {
        this.active = false;
        setGameStatus(`🎯 Temps écoulé ! Score : ${this.score} cibles atteintes`);
        playMelody(this.score >= 8 ? JINGLES.win : JINGLES.bip);
        activeGame = null;
        return;
      }
      const diff = Math.abs(wrapAngle(this.target - state.gyroZ));
      if (diff < 5) {
        if (!this.inZoneSince) this.inZoneSince = now;
        if (now - this.inZoneSince > 300) {
          this.score++;
          send(frameTone(nextIdx(), 900, 80));
          sendLed(0, 0, 255, 0);
          setTimeout(() => { if (activeGame === this) sendLed(0, 0, 0, 0); }, 120);
          this.target = state.gyroZ + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 120);
          this.inZoneSince = 0;
        }
      } else {
        this.inZoneSince = 0;
      }
      setGameStatus(`🎯 ${remaining.toFixed(1)} s · score ${this.score} · écart ${diff.toFixed(0)}°`);
    },
  },

  // ----- 9. DISCO -----
  disco: {
    label: '💃 Disco',
    lastFlash: 0, hue: 0, lastNote: 0, melodyIdx: 0,
    start() { this.lastFlash = 0; this.hue = 0; this.lastNote = 0; this.melodyIdx = 0; setGameStatus('💃 Disco — Tetris + LEDs'); },
    stop() {},
    tick(now) {
      if (now - this.lastFlash > 180) {
        this.lastFlash = now;
        this.hue = (this.hue + 40) % 360;
        const { r, g, b } = hslToRgb(this.hue, 1, 0.5);
        sendLed(0, r, g, b);
      }
      const notes = MELODIES.tetris.notes;
      if (now >= this.lastNote) {
        const [freq, dur] = notes[this.melodyIdx];
        if (freq > 0) send(frameTone(nextIdx(), freq, Math.min(dur, 100)));
        this.lastNote = now + dur + 20;
        this.melodyIdx = (this.melodyIdx + 1) % notes.length;
      }
    },
  },

  // ----- 10. POLICE -----
  police: {
    label: '🚨 Police',
    lastSwitch: 0, isRed: false, lastSirene: 0, sirenePhase: 0,
    start() { this.lastSwitch = 0; this.lastSirene = 0; setGameStatus('🚨 Police — gyrophare + sirène'); },
    stop() {},
    tick(now) {
      if (now - this.lastSwitch > 250) {
        this.lastSwitch = now;
        this.isRed = !this.isRed;
        sendLed(0, this.isRed ? 255 : 0, 0, this.isRed ? 0 : 255);
      }
      if (now - this.lastSirene > 120) {
        this.lastSirene = now;
        this.sirenePhase += 0.25;
        const freq = Math.round(700 + 500 * Math.sin(this.sirenePhase));
        send(frameTone(nextIdx(), freq, 100));
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Boucle principale (~30 Hz pour moteurs)
// ---------------------------------------------------------------------------

function setMaxSpeed(v) {
  state.maxSpeed = Math.max(0, Math.min(255, v));
  $('#speedRange').value = state.maxSpeed;
  $('#speedValue').value = state.maxSpeed;
}

function tick() {
  const now = performance.now();
  scanForGamepad();
  pollGamepad();

  const { m1, m2, throttle, turn } = computeMotorTargets();

  $('#m1Out').value = m1;
  $('#m2Out').value = m2;
  $('#throttleOut').value = throttle.toFixed(2);
  $('#turnOut').value = turn.toFixed(2);

  // On limite a ~20 Hz max pour ne pas saturer le buffer serie de l'Arduino
  // (64 octets, 2 trames de 11 octets par envoi = vite plein si on spam a 60 Hz).
  const changed = m1 !== state.lastM1 || m2 !== state.lastM2;
  const sinceLast = now - state.lastSendTs;
  const minInterval = 50;     // 20 Hz max
  const keepAlive = 250;      // keep-alive si rien ne change
  const shouldSend = state.connected && (
    (changed && sinceLast >= minInterval) ||
    sinceLast >= keepAlive
  );
  if (shouldSend) {
    sendMotors(m1, m2);
    state.lastM1 = m1;
    state.lastM2 = m2;
    state.lastSendTs = now;
  }

  pollUltrasonic(now);
  pollGyro(now);
  pollEncoderSpeed(now);
  updateGyroUI();
  updateSpeedUI();
  updateTiltLed(now);
  updateBackupRadar(now);
  updateSpinChallenge(now);
  if (activeGame && activeGame.tick) activeGame.tick(now);

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Câblage UI
// ---------------------------------------------------------------------------

$('#btnRefresh').addEventListener('click', refreshPorts);
$('#btnScanGamepad').addEventListener('click', () => {
  scanForGamepad();
  if (state.gamepadIndex === null) {
    log('Aucune manette exposée. Vérifie : fenêtre Electron au premier plan + un appui sur un bouton.', 'err');
  }
});
$('#btnConnect').addEventListener('click', connect);
$('#btnDisconnect').addEventListener('click', disconnect);

$('#speedRange').addEventListener('input', (e) => setMaxSpeed(parseInt(e.target.value, 10)));
$('#invertFwd').addEventListener('change', (e) => state.invertFwd = e.target.checked);
$('#invertM1').addEventListener('change', (e) => state.invertM1 = e.target.checked);
$('#invertM2').addEventListener('change', (e) => state.invertM2 = e.target.checked);
$('#swapMotors').addEventListener('change', (e) => state.swapMotors = e.target.checked);
$('#motorMode').addEventListener('change', (e) => state.motorMode = e.target.value);

$('#usPort').addEventListener('change', (e) => state.usPort = parseInt(e.target.value, 10));
$('#usEnable').addEventListener('change', (e) => state.usEnabled = e.target.checked);
$('#autoStop').addEventListener('change', (e) => state.autoStopEnabled = e.target.checked);
$('#autoStopCm').addEventListener('change', (e) => state.autoStopCm = parseInt(e.target.value, 10));
$('#backupRadar').addEventListener('change', (e) => {
  state.backupRadarEnabled = e.target.checked;
  if (e.target.checked) {
    // Force la lecture continue de l'ultrason : sinon radar muet.
    if (!state.usEnabled) {
      state.usEnabled = true;
      $('#usEnable').checked = true;
    }
  } else {
    sendLed(0, 0, 0, 0);
    state.radarLedOn = false;
    state.radarBand = null;
    $('#radarBand').textContent = '—';
  }
});

$('#btnLedApply').addEventListener('click', applyLedColor);
$('#btnLedOff').addEventListener('click', () => sendLed(0, 0, 0, 0));
$('#btnRainbow').addEventListener('click', ledRainbow);
$$('[data-preset]').forEach((b) => {
  b.addEventListener('click', () => {
    $('#ledColor').value = '#' + b.dataset.preset;
    applyLedColor();
  });
});

// Diagnostic : commandes moteur directes, sans la boucle tick ni les inversions.
// On reenvoie la commande toutes les 100 ms pendant la duree, car certains
// firmware Auriga ont un watchdog qui coupe les moteurs sans rafraichissement.
const diagTimers = { m1: null, m2: null };

function rawMotor(target, value) {
  const slot = target === 'm1' ? AURIGA.SLOT_M1 : AURIGA.SLOT_M2;
  if (state.motorMode === 'encSpeed') {
    send(frameSetEncoderSpeed(nextIdx(), slot, value));
  } else if (state.motorMode === 'encPwm') {
    send(frameSetEncoderPwm(nextIdx(), slot, value));
  } else {
    const port = target === 'm1' ? AURIGA.MOTOR_M1_PORT : AURIGA.MOTOR_M2_PORT;
    send(frameSetDcMotor(nextIdx(), port, value));
  }
}

function diagRun(target, value, durationMs) {
  if (diagTimers[target]) { clearInterval(diagTimers[target].intervalId); clearTimeout(diagTimers[target].stopId); }
  log(`Diag ${target} = ${value} pendant ${durationMs}ms (mode ${state.motorMode})`, 'info');
  rawMotor(target, value);
  const intervalId = setInterval(() => rawMotor(target, value), 100); // keep-alive contre watchdog
  const stopId = setTimeout(() => {
    clearInterval(intervalId);
    rawMotor(target, 0);
    diagTimers[target] = null;
    log(`Diag ${target} arrete`, 'info');
  }, durationMs);
  diagTimers[target] = { intervalId, stopId };
}

$$('[data-diag]').forEach((b) => {
  b.addEventListener('click', async () => {
    const what = b.dataset.diag;
    if (!state.connected) { log('Pas connecte', 'err'); return; }
    if (what === 'stop') {
      for (const t of ['m1', 'm2']) {
        if (diagTimers[t]) { clearInterval(diagTimers[t].intervalId); clearTimeout(diagTimers[t].stopId); diagTimers[t] = null; }
      }
      rawMotor('m1', 0);
      rawMotor('m2', 0);
    } else if (what === 'reset') {
      await send(frameReset(nextIdx()));
      log('RESET envoye', 'ok');
    } else {
      const map = {
        m1fwd: ['m1', 120],
        m1rev: ['m1', -120],
        m2fwd: ['m2', 120],
        m2rev: ['m2', -120],
      };
      const [t, v] = map[what];
      diagRun(t, v, 1500);
    }
  });
});

$('#btnTone').addEventListener('click', () => {
  playTone(parseInt($('#toneFreq').value, 10), parseInt($('#toneDur').value, 10));
});
$$('[data-note]').forEach((b) => {
  b.addEventListener('click', () => playTone(parseInt(b.dataset.note, 10), 180));
});
$('#btnSiren').addEventListener('click', playSiren);

// Gyroscope
$('#btnResetYaw').addEventListener('click', () => {
  if (state.gyroZ === null) { log('Gyroscope pas encore lu', 'err'); return; }
  state.yawOffset = state.gyroZ;
  log('Yaw remis a zero (Nord = direction actuelle)', 'ok');
});
$('#headingHold').addEventListener('change', (e) => {
  state.headingHoldEnabled = e.target.checked;
  state.headingLocked = false;
  log(`Heading Hold ${e.target.checked ? 'actif' : 'desactive'}`);
});
$('#headingKp').addEventListener('input', (e) => {
  state.headingKp = parseFloat(e.target.value);
  $('#headingKpOut').value = state.headingKp.toFixed(1);
});
$('#headingFlip').addEventListener('change', (e) => state.headingFlip = e.target.checked);
$('#tiltLed').addEventListener('change', (e) => {
  state.tiltLedEnabled = e.target.checked;
  if (!e.target.checked && state.connected) sendLed(0, 0, 0, 0);
});
$('#btnSpinChallenge').addEventListener('click', startSpinChallenge);
$('#wheelMm').addEventListener('change', (e) => {
  const v = parseInt(e.target.value, 10);
  if (isFinite(v) && v > 0) state.wheelMm = v;
});

// Jeux
$('#btnGameStart').addEventListener('click', () => startGame($('#gameSelect').value));
$('#btnGameStop').addEventListener('click', stopActiveGame);
$('#gameSelect').addEventListener('change', () => {
  // Stoppe le jeu en cours si on change la selection.
  if (activeGame) stopActiveGame();
  setGameStatus(`Sélection : ${GAMES[$('#gameSelect').value]?.label || ''} — clique Démarrer.`);
});
// Clavier : Enter = action (equivalent du bouton A manette dans les jeux).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && activeGame && activeGame.onButton) {
    if (activeGame.onButton(0)) e.preventDefault();
  }
});

// Démarrage
refreshPorts();
setMaxSpeed(state.maxSpeed);
log('Prêt. Sélectionne un port et clique sur "Connecter".');
requestAnimationFrame(tick);
