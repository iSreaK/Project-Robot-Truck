// Protocole série Makeblock pour Me Auriga (mBot Ranger).
//
// Format d'une trame émise :
//   0xFF 0x55  LEN  IDX  ACTION  DEVICE  PORT  [DATA...]
// LEN = nombre d'octets après LEN (donc IDX + ACTION + DEVICE + PORT + DATA).
//
// Format d'une trame reçue :
//   0xFF 0x55  IDX  TYPE  [DATA...]  0x0D 0x0A
// TYPE : 1=byte, 2=float (4o LE), 3=short (2o LE), 4=string (1o longueur + N), 5=double, 6=long.

'use strict';

// Actions
const ACTION = {
  GET: 1,
  RUN: 2,
  RESET: 3,
  START: 4,
};

// Devices (sous-ensemble utile pour Auriga)
const DEVICE = {
  VERSION: 0,
  ULTRASONIC_SENSOR: 1,
  RGBLED: 8,
  DC_MOTOR: 10,
  TONE: 34,
  ENCODER_BOARD: 61,
};

// Constantes Auriga embarquées
const AURIGA = {
  ONBOARD_LED_RING_PORT: 44, // anneau de 12 LEDs RGB
  ONBOARD_BUZZER_PORT: 45,
  ONBOARD_ENCODER_PORT: 0,   // port virtuel pour les moteurs M1/M2 en mode encodeur
  SLOT_M1: 1,
  SLOT_M2: 2,
  MOTOR_M1_PORT: 9,  // pour le mode DC_MOTOR direct
  MOTOR_M2_PORT: 10,
};

// Sous-commandes ENCODER_BOARD
const ENCODER_CMD = {
  POS_MOTION: 1, // déplacement à une position
  SPEED_MOTION: 2, // boucle fermée vitesse (rpm)
  PWM_MOTION: 3, // PWM direct (-255..255) — le plus simple
};

// Types de réponse
const RESP_TYPE = {
  BYTE: 1,
  FLOAT: 2,
  SHORT: 3,
  STRING: 4,
  DOUBLE: 5,
  LONG: 6,
};

// ----------------------------------------------------------------------------
// Encodage
// ----------------------------------------------------------------------------

function buildFrame(idx, action, device, port, dataBuf = Buffer.alloc(0)) {
  // Corps = IDX + ACTION + DEVICE + PORT + DATA
  const bodyLen = 1 + 1 + 1 + 1 + dataBuf.length;
  const frame = Buffer.alloc(3 + bodyLen);
  frame[0] = 0xff;
  frame[1] = 0x55;
  frame[2] = bodyLen;
  frame[3] = idx & 0xff;
  frame[4] = action;
  frame[5] = device;
  frame[6] = port;
  dataBuf.copy(frame, 7);
  return frame;
}

function int16LE(value) {
  const b = Buffer.alloc(2);
  // Clamp & signed conversion
  const v = Math.max(-32768, Math.min(32767, Math.round(value)));
  b.writeInt16LE(v, 0);
  return b;
}

// Trame pour piloter un moteur encodeur de l'Auriga en PWM (-255..255).
function frameSetEncoderPwm(idx, slot, pwm) {
  const data = Buffer.concat([
    Buffer.from([slot, ENCODER_CMD.PWM_MOTION]),
    int16LE(pwm),
  ]);
  return buildFrame(idx, ACTION.RUN, DEVICE.ENCODER_BOARD, AURIGA.ONBOARD_ENCODER_PORT, data);
}

// Trame pour piloter un moteur en mode DC direct (alternative).
function frameSetDcMotor(idx, port, speed) {
  return buildFrame(idx, ACTION.RUN, DEVICE.DC_MOTOR, port, int16LE(speed));
}

// Trame pour interroger l'ultrason.
function frameReadUltrasonic(idx, port) {
  return buildFrame(idx, ACTION.GET, DEVICE.ULTRASONIC_SENSOR, port);
}

// Trame pour piloter une LED de l'anneau (ledIndex 0 = toutes, 1..12 pour individuelles).
function frameSetLed(idx, port, slot, ledIndex, r, g, b) {
  const data = Buffer.from([slot, ledIndex, r & 0xff, g & 0xff, b & 0xff]);
  return buildFrame(idx, ACTION.RUN, DEVICE.RGBLED, port, data);
}

// Trame pour jouer une note sur le buzzer embarqué de l'Auriga.
function frameTone(idx, freq, durationMs) {
  const data = Buffer.concat([int16LE(freq), int16LE(durationMs)]);
  return buildFrame(idx, ACTION.RUN, DEVICE.TONE, AURIGA.ONBOARD_BUZZER_PORT, data);
}

// Trame pour récupérer la version du firmware (utile comme ping).
function frameGetVersion(idx) {
  return buildFrame(idx, ACTION.GET, DEVICE.VERSION, 0);
}

// Reset général (stoppe tous les moteurs côté Auriga).
function frameReset(idx) {
  const frame = Buffer.alloc(5);
  frame[0] = 0xff;
  frame[1] = 0x55;
  frame[2] = 2;
  frame[3] = idx & 0xff;
  frame[4] = ACTION.RESET;
  return frame;
}

// ----------------------------------------------------------------------------
// Décodage (parser à états)
// ----------------------------------------------------------------------------
//
// Les réponses ont la forme : FF 55 IDX TYPE [DATA] 0D 0A
// On accumule les octets et on émet une réponse complète quand on a vu 0D 0A.

class ResponseParser {
  constructor(onResponse) {
    this.onResponse = onResponse;
    this.buf = [];
    this.state = 'WAIT_FF';
  }

  feed(chunk) {
    for (const byte of chunk) {
      this._feedByte(byte);
    }
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
          // re-sync sur un nouveau 0xFF
          this.buf = [0xff];
        } else {
          this.state = 'WAIT_FF';
          this.buf = [];
        }
        break;
      case 'BODY':
        this.buf.push(b);
        // Détection fin de trame : suite 0x0D 0x0A
        const len = this.buf.length;
        if (len >= 4 && this.buf[len - 2] === 0x0d && this.buf[len - 1] === 0x0a) {
          this._emit(this.buf);
          this.state = 'WAIT_FF';
          this.buf = [];
        }
        // Garde-fou : si la trame devient absurdement longue, on resynchronise
        if (len > 64) {
          this.state = 'WAIT_FF';
          this.buf = [];
        }
        break;
    }
  }

  _emit(buf) {
    // buf = [FF, 55, IDX, TYPE, ...DATA, 0D, 0A]
    if (buf.length < 6) return;
    const idx = buf[2];
    const type = buf[3];
    const data = Buffer.from(buf.slice(4, buf.length - 2));
    let value = null;
    try {
      switch (type) {
        case RESP_TYPE.BYTE:
          value = data[0];
          break;
        case RESP_TYPE.FLOAT:
          value = data.readFloatLE(0);
          break;
        case RESP_TYPE.SHORT:
          value = data.readInt16LE(0);
          break;
        case RESP_TYPE.LONG:
          value = data.readInt32LE(0);
          break;
        case RESP_TYPE.DOUBLE:
          value = data.readDoubleLE(0);
          break;
        case RESP_TYPE.STRING: {
          const strLen = data[0];
          value = data.slice(1, 1 + strLen).toString('utf8');
          break;
        }
        default:
          value = data; // type inconnu, on remonte le buffer brut
      }
    } catch (err) {
      value = null;
    }
    this.onResponse({ idx, type, value });
  }
}

module.exports = {
  ACTION,
  DEVICE,
  AURIGA,
  ENCODER_CMD,
  RESP_TYPE,
  buildFrame,
  frameSetEncoderPwm,
  frameSetDcMotor,
  frameReadUltrasonic,
  frameSetLed,
  frameTone,
  frameGetVersion,
  frameReset,
  ResponseParser,
};
