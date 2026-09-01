// Opple Light Master 3 / 4 - BLE transport framing and payload parsing.
//
// Both meters expose a Nordic UART Service. Commands are an 11-byte header
// (+ optional body) wrapped in a small fragmentation layer; responses come
// back as notifications in the same framing. The Opple app writes commands
// to the *notify* characteristic (6e400003) - the meter accepts that, and
// it is what every working implementation does.
//
// Protocol facts: OlliV/open-light-master (LM3), gabrielebaudo/opple-bridge
// (LM4 layouts, from the decompiled Opple app), Geomaniac15/tag-tester.

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // host -> device (unused by Opple)
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device -> host, also accepts writes

export const OPCODE = {
  REQ_MEAS: 0x0a00, // 2560 single measurement
  RES_MEAS: 0x0a01, // 2561
  REQ_CAL: 0x0a04, //  2564 read per-unit sensor calibration (kSensor)
  RES_CAL: 0x0a05, //  2565
  REQ_FREQ: 0x0a0a, // 2570 flicker waveform (not used here)
  RES_FREQ: 0x0a0b, // 2571
};

const FRAG_SINGLE = 0x00;
const FRAG_FIRST = 0x80;
const FRAG_MIDDLE = 0xa0;
const FRAG_LAST = 0xc0;
const FRAG_MASK = 0xe0;

const HEADER_LEN = 11;

/** Build the inner message: 11-byte header followed by the body. */
export function buildCommand(opcode, seq, body = new Uint8Array(0)) {
  const out = new Uint8Array(HEADER_LEN + body.length);
  out.set([0x00, 0x13, 0x00, 0x00, seq & 0xff, 0x00, body.length & 0xff, 0x00, 0x00, (opcode >> 8) & 0xff, opcode & 0xff]);
  out.set(body, HEADER_LEN);
  return out;
}

/** Split an inner message into BLE write fragments (first carries 17 bytes, the rest 19). */
export function encapsulate(data) {
  const n = data.length < 17 ? 1 : Math.ceil((data.length - 17) / 19) + 1;
  const frames = [];
  for (let c = 0; c < n; c++) {
    let head;
    let body;
    if (c === 0) {
      const total = data.length + n + 2;
      head = [n > 1 ? FRAG_FIRST : FRAG_SINGLE, (total >> 8) & 0xff, total & 0xff];
      body = n > 1 ? data.subarray(0, 17) : data;
    } else if (c !== n - 1) {
      head = [FRAG_MIDDLE | c];
      body = data.subarray(17 + 19 * (c - 1), 17 + 19 * c);
    } else {
      head = [FRAG_LAST | c];
      body = data.subarray(17 + 19 * (c - 1));
    }
    const frame = new Uint8Array(head.length + body.length);
    frame.set(head);
    frame.set(body, head.length);
    frames.push(frame);
  }
  return frames;
}

/** Reassembles fragmented notifications. feed() returns a complete inner message or null. */
export class MessageAssembler {
  constructor() {
    this.buffer = null;
  }

  reset() {
    this.buffer = null;
  }

  feed(frame) {
    if (!frame || frame.length === 0) return null;
    const type = frame[0] & FRAG_MASK;
    if (type === FRAG_SINGLE) {
      this.buffer = null;
      return frame.slice(3);
    }
    if (type === FRAG_FIRST) {
      this.buffer = Array.from(frame.subarray(3));
      return null;
    }
    if (type === FRAG_MIDDLE) {
      if (this.buffer) this.buffer.push(...frame.subarray(1));
      return null;
    }
    if (type === FRAG_LAST) {
      if (!this.buffer) return null;
      this.buffer.push(...frame.subarray(1));
      const msg = Uint8Array.from(this.buffer);
      this.buffer = null;
      return msg;
    }
    return null;
  }
}

export function opcodeOf(msg) {
  if (!msg || msg.length < HEADER_LEN) return 0;
  return (msg[9] << 8) | msg[10];
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];

/**
 * Parse a RES_MEAS message. Model is detected from the payload length:
 *   LM3: [0]=skip, [1..12]=6 x u16 BE (450/500/550/570/600/650 nm), [13..14]=battery mV, [15]=temperature
 *   LM4: [0]=skip, [1..18]=9 x u16 BE (AS7341 F1..F8 + clear), [19..20]=temperature x10 (°C), [21..22]=battery raw
 *   (LM4 layout confirmed on a real unit: 23-byte payload, clear is the largest channel,
 *    word 9 read 275 = 27.5 °C on a desk, battery raw 3314.)
 */
export function parseMeasurement(msg) {
  if (!msg || msg.length < HEADER_LEN + 16) return null;
  const p = msg.subarray(HEADER_LEN);
  if (p.length >= 23) {
    const raw = [];
    for (let i = 0; i < 9; i++) raw.push(u16be(p, 1 + 2 * i));
    const t10 = u16be(p, 19);
    const temperature = t10 > 0 && t10 < 1200 ? t10 / 10 : null;
    return { model: 'lm4', raw, batteryRaw: u16be(p, 21), temperature };
  }
  const raw = [];
  for (let i = 0; i < 6; i++) raw.push(u16be(p, 1 + 2 * i));
  return { model: 'lm3', raw, batteryRaw: u16be(p, 13), temperature: p[15] };
}

/**
 * Parse a RES_CAL message: float32 little-endian factors starting at payload[1]
 * (7 for the LM3 - six channels plus the constant C1 input; 9 for the LM4).
 */
export function parseCalibration(msg) {
  if (!msg || msg.length < HEADER_LEN + 29) return null;
  const p = msg.subarray(HEADER_LEN);
  const count = p.length >= 37 ? 9 : 7;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const kSensor = [];
  for (let i = 0; i < count; i++) {
    const v = view.getFloat32(1 + 4 * i, true);
    kSensor.push(Number.isFinite(v) ? v : 1);
  }
  return { model: count === 9 ? 'lm4' : 'lm3', kSensor };
}
