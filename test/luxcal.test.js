// Per-meter lux calibration: a user factor from a reference lux meter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseMeasurement, parseCalibration } from '../src/protocol.js';
import { processMeasurement, sanitiseLuxFactor, meterKey } from '../src/meter.js';

const here = dirname(fileURLToPath(import.meta.url));
const bench = JSON.parse(readFileSync(join(here, 'fixtures', 'bench-2026-11-04.json'), 'utf8'));
const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
const point = bench.points.find((p) => p.label === '4000 K');

for (const model of ['lm3', 'lm4']) {
  test(`${model}: a lux factor scales lux and EML, and leaves colour alone`, () => {
    const meas = parseMeasurement(hex(point[model]));
    const cal = parseCalibration(hex(bench.calibration[model]));
    const base = processMeasurement(meas, cal);
    const cal16 = processMeasurement(meas, cal, { luxFactor: 1.16 });
    assert.equal(base.luxFactor, 1);
    assert.equal(cal16.luxFactor, 1.16);
    assert.ok(Math.abs(cal16.lux / base.lux - 1.16) < 1e-9, `lux ${cal16.lux} vs ${base.lux}`);
    assert.ok(Math.abs(cal16.eml / base.eml - 1.16) < 1e-9, `eml ${cal16.eml} vs ${base.eml}`);
    for (const k of ['cct', 'duv', 'x', 'y', 'Ra']) assert.ok(Math.abs(cal16[k] - base[k]) < 1e-9, `${k} changed`);
    if (model === 'lm4') assert.ok(cal16.cs > base.cs, 'circadian stimulus rises with lux');
  });
}

test('lux factor: missing, non-numeric or out-of-range values fall back to 1', () => {
  assert.equal(sanitiseLuxFactor(undefined), 1);
  assert.equal(sanitiseLuxFactor('abc'), 1);
  assert.equal(sanitiseLuxFactor(0), 1);
  assert.equal(sanitiseLuxFactor(0.4), 1);
  assert.equal(sanitiseLuxFactor(2.5), 1);
  assert.equal(sanitiseLuxFactor(1.16), 1.16);
  assert.equal(sanitiseLuxFactor('0.86'), 0.86);
  const meas = parseMeasurement(hex(point.lm4));
  const cal = parseCalibration(hex(bench.calibration.lm4));
  assert.equal(processMeasurement(meas, cal, { luxFactor: 9 }).lux, processMeasurement(meas, cal).lux);
});

test('meter key: per unit from the advertised name, else the browser device id', () => {
  assert.equal(meterKey('lm4', { name: 'LMaster_d82d', id: 'abc' }), 'lm4:LMaster_d82d');
  assert.equal(meterKey('lm3', { name: 'LMaster_15ce', id: 'xyz' }), 'lm3:LMaster_15ce');
  assert.equal(meterKey('lm4', { name: 'SigMesh', id: 'dev-1' }), 'lm4:dev-1');
  assert.equal(meterKey('lm3', { name: 'LightMaster', id: 'dev-2' }), 'lm3:dev-2');
  assert.equal(meterKey('lm3', null), null);
});
