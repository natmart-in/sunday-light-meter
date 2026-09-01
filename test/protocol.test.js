import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCommand, encapsulate, MessageAssembler, opcodeOf, parseMeasurement, parseCalibration, OPCODE } from '../src/protocol.js';

const header = (opcode, payloadLen) => [0x00, 0x13, 0x00, 0x00, 0x01, 0x00, payloadLen & 0xff, 0x00, 0x00, (opcode >> 8) & 0xff, opcode & 0xff];
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const f32le = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return Array.from(b);
};

test('buildCommand lays out the 11-byte header', () => {
  const cmd = buildCommand(OPCODE.REQ_MEAS, 7);
  assert.deepEqual(Array.from(cmd), [0, 0x13, 0, 0, 7, 0, 0, 0, 0, 0x0a, 0x00]);
  const withBody = buildCommand(OPCODE.REQ_FREQ, 2, Uint8Array.from([0, 0, 25]));
  assert.equal(withBody[6], 3);
  assert.deepEqual(Array.from(withBody.subarray(11)), [0, 0, 25]);
});

test('short commands are a single frame with total length', () => {
  const frames = encapsulate(buildCommand(OPCODE.REQ_CAL, 1));
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], 0x00);
  assert.equal((frames[0][1] << 8) | frames[0][2], 11 + 1 + 2);
  assert.equal(frames[0].length, 14);
});

test('long messages fragment 17/19/... and reassemble', () => {
  const body = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
  const msg = buildCommand(0x1234, 9, body);
  const frames = encapsulate(msg);
  assert.equal(frames.length, 3);
  assert.equal(frames[0][0], 0x80);
  assert.equal(frames[1][0], 0xa0 | 1);
  assert.equal(frames[2][0], 0xc0 | 2);
  assert.equal(frames[0].length, 3 + 17);
  assert.equal(frames[1].length, 1 + 19);
  const asm = new MessageAssembler();
  let out = null;
  for (const f of frames) out = asm.feed(f) || out;
  assert.deepEqual(Array.from(out), Array.from(msg));
  assert.equal(opcodeOf(out), 0x1234);
});

test('assembler ignores orphan middle/last fragments and unknown types', () => {
  const asm = new MessageAssembler();
  assert.equal(asm.feed(Uint8Array.from([0xa1, 1, 2])), null);
  assert.equal(asm.feed(Uint8Array.from([0xc2, 1, 2])), null);
  assert.equal(asm.feed(Uint8Array.from([0x60, 1, 2])), null);
  assert.equal(asm.feed(new Uint8Array(0)), null);
});

test('LM3 measurement: 6 big-endian channels, battery mV, temperature', () => {
  const payload = [0x00, ...[100, 200, 300, 400, 500, 600].flatMap(be16), ...be16(3900), 24];
  const msg = Uint8Array.from([...header(OPCODE.RES_MEAS, payload.length), ...payload]);
  const m = parseMeasurement(msg);
  assert.equal(m.model, 'lm3');
  assert.deepEqual(m.raw, [100, 200, 300, 400, 500, 600]);
  assert.equal(m.batteryRaw, 3900);
  assert.equal(m.temperature, 24);
});

test('LM4 measurement: 9 big-endian channels then padding and battery', () => {
  const payload = [0x00, ...[100, 200, 300, 400, 500, 600, 700, 800, 900].flatMap(be16), 0, 0, ...be16(3344)];
  assert.equal(payload.length, 23);
  const msg = Uint8Array.from([...header(OPCODE.RES_MEAS, payload.length), ...payload]);
  const m = parseMeasurement(msg);
  assert.equal(m.model, 'lm4');
  assert.deepEqual(m.raw, [100, 200, 300, 400, 500, 600, 700, 800, 900]);
  assert.equal(m.batteryRaw, 3344);
  assert.equal(m.temperature, null);
});

test('truncated measurement returns null', () => {
  assert.equal(parseMeasurement(new Uint8Array(10)), null);
  assert.equal(parseMeasurement(null), null);
});

test('calibration: 7 floats for LM3, 9 for LM4, little-endian at payload[1]', () => {
  const k3 = [1.01, 0.99, 1.05, 0.97, 1.0, 1.02, 0.5];
  const p3 = [0x00, ...k3.flatMap(f32le), ...be16(3900)];
  const c3 = parseCalibration(Uint8Array.from([...header(OPCODE.RES_CAL, p3.length), ...p3]));
  assert.equal(c3.model, 'lm3');
  assert.equal(c3.kSensor.length, 7);
  c3.kSensor.forEach((v, i) => assert.ok(Math.abs(v - k3[i]) < 1e-6));

  const k4 = [1.010141, 1.009422, 0.928753, 1.037585, 0.968898, 1.181077, 0.961893, 1.059147, 1.0];
  const p4 = [0x00, ...k4.flatMap(f32le), 0, 0, 0, 0];
  const c4 = parseCalibration(Uint8Array.from([...header(OPCODE.RES_CAL, p4.length), ...p4]));
  assert.equal(c4.model, 'lm4');
  assert.equal(c4.kSensor.length, 9);
  c4.kSensor.forEach((v, i) => assert.ok(Math.abs(v - k4[i]) < 1e-6));

  assert.equal(parseCalibration(new Uint8Array(20)), null);
});
