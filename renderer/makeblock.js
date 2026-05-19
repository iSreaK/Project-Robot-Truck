// Protocole série Makeblock pour Me Auriga — version navigateur (Uint8Array).
// Le code Node équivalent vit dans lib/makeblock.js, mais le renderer Electron
// est sandboxé donc on duplique ici pour éviter des allers-retours IPC.

'use strict';

export const ACTION = { GET: 1, RUN: 2, RESET: 3, START: 4 };

export const DEVICE = {
  VERSION: 0,
  ULTRASONIC_SENSOR: 1,
  GYRO: 6,
  RGBLED: 8,
  DC_MOTOR: 10,
  TONE: 34,
  ENCODER_BOARD: 61,
};

// Axes du MPU-6050 lus par le firmware d'usine.
export const GYRO_AXIS = { X: 1, Y: 2, Z: 3 };

export const AURIGA = {
  // L'anneau de 12 LEDs embarqué de l'Auriga se commande avec port=0 et slot=2
  // (le firmware redirige alors vers la broche interne 44). port=44 directement
  // ne marche que sur certaines forks anciennes du firmware.
  ONBOARD_LED_RING_PORT: 0,
  ONBOARD_LED_RING_SLOT: 2,
  ONBOARD_BUZZER_PORT: 45,
  ONBOARD_ENCODER_PORT: 0,
  SLOT_M1: 1,
  SLOT_M2: 2,
  MOTOR_M1_PORT: 9,
  MOTOR_M2_PORT: 10,
};

const ENCODER_CMD = { POS_MOTION: 1, SPEED_MOTION: 2, PWM_MOTION: 3 };
// Sous-commandes du GET ENCODER_BOARD : 1 = position (long), 2 = vitesse (float, RPM).
const ENCODER_GET = { POS: 1, SPEED: 2 };

// Plage rpm pour la commande vitesse boucle-fermee des moteurs Ranger : ~ +/- 200.
export const ENCODER_SPEED_MAX = 200;

const RESP_TYPE = {
  BYTE: 1,
  FLOAT: 2,
  SHORT: 3,
  STRING: 4,
  DOUBLE: 5,
  LONG: 6,
};

// ---------------------------------------------------------------------------
// Encodage
// ---------------------------------------------------------------------------

function int16LE(value) {
  const v = Math.max(-32768, Math.min(32767, Math.round(value)));
  const out = new Uint8Array(2);
  const view = new DataView(out.buffer);
  view.setInt16(0, v, true);
  return out;
}

function buildFrame(idx, action, device, port, data = new Uint8Array(0)) {
  const bodyLen = 4 + data.length; // IDX + ACTION + DEVICE + PORT + DATA
  const frame = new Uint8Array(3 + bodyLen);
  frame[0] = 0xff;
  frame[1] = 0x55;
  frame[2] = bodyLen;
  frame[3] = idx & 0xff;
  frame[4] = action;
  frame[5] = device;
  frame[6] = port;
  frame.set(data, 7);
  return frame;
}

export function frameSetEncoderPwm(idx, slot, pwm) {
  const speed = int16LE(pwm);
  const data = new Uint8Array(2 + speed.length);
  data[0] = slot;
  data[1] = ENCODER_CMD.PWM_MOTION;
  data.set(speed, 2);
  return buildFrame(idx, ACTION.RUN, DEVICE.ENCODER_BOARD, AURIGA.ONBOARD_ENCODER_PORT, data);
}

// Vitesse en boucle fermee pour les moteurs encodeur (rpm-like, +/- 200).
// C'est ce qu'envoie mBlock par defaut et qui marche partout.
export function frameSetEncoderSpeed(idx, slot, speed) {
  const s = int16LE(speed);
  const data = new Uint8Array(2 + s.length);
  data[0] = slot;
  data[1] = ENCODER_CMD.SPEED_MOTION;
  data.set(s, 2);
  return buildFrame(idx, ACTION.RUN, DEVICE.ENCODER_BOARD, AURIGA.ONBOARD_ENCODER_PORT, data);
}

export function frameSetDcMotor(idx, port, speed) {
  return buildFrame(idx, ACTION.RUN, DEVICE.DC_MOTOR, port, int16LE(speed));
}

export function frameReadUltrasonic(idx, port) {
  return buildFrame(idx, ACTION.GET, DEVICE.ULTRASONIC_SENSOR, port);
}

// Gyro embarque : port 1 = onboard (I2C 0x69), axe 1=X (pitch), 2=Y (roll), 3=Z (yaw).
// Reponse : float (degres).
export function frameReadGyro(idx, axis) {
  return buildFrame(idx, ACTION.GET, DEVICE.GYRO, 1, new Uint8Array([axis]));
}

// Vitesse courante d'un moteur encodeur (slot 1 ou 2 sur l'Auriga). Reponse float = RPM.
export function frameReadEncoderSpeed(idx, slot) {
  return buildFrame(idx, ACTION.GET, DEVICE.ENCODER_BOARD, AURIGA.ONBOARD_ENCODER_PORT, new Uint8Array([slot, ENCODER_GET.SPEED]));
}

export function frameSetLed(idx, port, slot, ledIndex, r, g, b) {
  const data = new Uint8Array([slot, ledIndex, r & 0xff, g & 0xff, b & 0xff]);
  return buildFrame(idx, ACTION.RUN, DEVICE.RGBLED, port, data);
}

export function frameTone(idx, freq, durationMs) {
  const f = int16LE(freq);
  const d = int16LE(durationMs);
  const data = new Uint8Array(f.length + d.length);
  data.set(f, 0);
  data.set(d, f.length);
  return buildFrame(idx, ACTION.RUN, DEVICE.TONE, AURIGA.ONBOARD_BUZZER_PORT, data);
}

export function frameGetVersion(idx) {
  return buildFrame(idx, ACTION.GET, DEVICE.VERSION, 0);
}

export function frameReset(idx) {
  return new Uint8Array([0xff, 0x55, 2, idx & 0xff, ACTION.RESET]);
}

// ---------------------------------------------------------------------------
// Parser de réponses (machine à états)
// ---------------------------------------------------------------------------

export class ResponseParser {
  constructor(onResponse) {
    this.onResponse = onResponse;
    this.buf = [];
    this.state = 'WAIT_FF';
  }

  feed(chunk) {
    for (const byte of chunk) this._feedByte(byte);
  }

  _feedByte(b) {
    switch (this.state) {
      case 'WAIT_FF':
        if (b === 0xff) {
          this.buf = [0xff];
          this.state = 'WAIT_55';
        }
        break;
      case 'WAIT_55':
        if (b === 0x55) {
          this.buf.push(0x55);
          this.state = 'BODY';
        } else if (b === 0xff) {
          this.buf = [0xff];
        } else {
          this.state = 'WAIT_FF';
          this.buf = [];
        }
        break;
      case 'BODY':
        this.buf.push(b);
        const len = this.buf.length;
        if (len >= 4 && this.buf[len - 2] === 0x0d && this.buf[len - 1] === 0x0a) {
          this._emit(this.buf);
          this.state = 'WAIT_FF';
          this.buf = [];
        } else if (len > 64) {
          this.state = 'WAIT_FF';
          this.buf = [];
        }
        break;
    }
  }

  _emit(raw) {
    if (raw.length < 6) return;
    const idx = raw[2];
    const type = raw[3];
    const dataBytes = raw.slice(4, raw.length - 2);
    const data = new Uint8Array(dataBytes);
    const view = new DataView(data.buffer);
    let value = null;
    try {
      switch (type) {
        case RESP_TYPE.BYTE:
          value = data[0];
          break;
        case RESP_TYPE.FLOAT:
          value = view.getFloat32(0, true);
          break;
        case RESP_TYPE.SHORT:
          value = view.getInt16(0, true);
          break;
        case RESP_TYPE.LONG:
          value = view.getInt32(0, true);
          break;
        case RESP_TYPE.DOUBLE:
          value = view.getFloat64(0, true);
          break;
        case RESP_TYPE.STRING: {
          const n = data[0];
          value = new TextDecoder().decode(data.slice(1, 1 + n));
          break;
        }
        default:
          value = data;
      }
    } catch (_) {
      value = null;
    }
    this.onResponse({ idx, type, value });
  }
}
