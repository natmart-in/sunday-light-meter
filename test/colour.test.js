import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { lm3Process, lm3Calibrate } from '../src/lm3.js';
import { lm4Process, lm4Calibrate, lm4Predict, lm4CircadianStimulus, lm4Battery } from '../src/lm4.js';
import { batteryFromMv, cctFromXy, duvFromUv, xyToUv, interpolateSpd, calcCri } from '../src/colour.js';
import { processMeasurement } from '../src/meter.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'fixtures', 'lm3-reference.json'), 'utf8'));

const close = (a, b, rel = 1e-9, what = '') => {
  if (b === null || b === undefined) return;
  const tol = Math.max(Math.abs(b) * rel, 1e-9);
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
};

test('LM3 pipeline matches the validated Python port (open-light-master maths)', () => {
  for (const f of ref.fixtures) {
    const { channels, c1 } = lm3Calibrate(f.raw, f.k);
    channels.forEach((c, i) => close(c, f.channels[i], 1e-12, `${f.name} ch${i}`));
    close(c1, f.c1, 1e-12, `${f.name} c1`);
    const r = lm3Process(channels, c1);
    assert.equal(r.mode, f.mode, `${f.name} mode`);
    close(r.x, f.x, 1e-9, `${f.name} x`);
    close(r.y, f.y, 1e-9, `${f.name} y`);
    close(r.u, f.u, 1e-9, `${f.name} u`);
    close(r.v, f.v, 1e-9, `${f.name} v`);
    close(r.lux, f.lux, 1e-9, `${f.name} lux`);
    close(r.duv, f.duv, 1e-9, `${f.name} duv`);
    if (f.cct !== null) close(r.cct, f.cct, 1e-9, `${f.name} cct`);
    if (f.tint !== null) close(r.tint, f.tint, 1e-9, `${f.name} tint`);
    if (f.Ra !== undefined) {
      close(r.Ra, f.Ra, 1e-8, `${f.name} Ra`);
      r.R.forEach((v, i) => close(v, f.R[i], 1e-8, `${f.name} R${i + 1}`));
      close(r.eml, f.eml, 1e-9, `${f.name} eml`);
      r.spd.forEach((v, i) => close(v, f.spd[i], 1e-9, `${f.name} spd[${i}]`));
    }
  }
});

test('battery curve matches reference', () => {
  for (const [mv, pct] of Object.entries(ref.battery)) close(batteryFromMv(Number(mv)), pct, 1e-12, `battery ${mv}`);
});

// Real LM4 probe (opple-bridge test vector) with the values the official Opple
// app displayed for the same light: CCT 4236 K, 2057 lx, Ra 96.5, R9 52.2,
// EML 1680, CS 0.619. The lux/EML gap is the two readings being seconds apart.
const LM4_K = [1.010141, 1.009422, 0.928753, 1.037585, 0.968898, 1.181077, 0.961893, 1.059147, 1.0];
const LM4_RAW = [654, 819, 855, 1152, 1330, 1719, 2595, 3715, 14571];

test('LM4 pipeline reproduces the official Opple app', () => {
  const { channels } = lm4Calibrate(LM4_RAW, LM4_K);
  const r = lm4Process(channels);
  assert.ok(Math.abs(r.cct - 4236) < 10, `CCT ${r.cct}`);
  assert.ok(Math.abs(r.lux - 2057) / 2057 < 0.05, `lux ${r.lux}`);
  assert.ok(Math.abs(r.Ra - 96.5) < 1, `Ra ${r.Ra}`);
  assert.ok(Math.abs(r.R[8] - 52.2) < 2, `R9 ${r.R[8]}`);
  assert.ok(Math.abs(r.eml - 1680) < 150, `EML ${r.eml}`);
  assert.ok(Math.abs(r.cs - 0.619) < 0.1, `CS ${r.cs}`);
  assert.equal(r.criSource, 'opple-model');
  assert.equal(r.R.length, 14);
  r.R.forEach((v) => assert.ok(v <= 100));
  // Cross-check the exact numbers against the Python reference implementation.
  assert.ok(Math.abs(r.cct - 4239) < 1, `CCT exact ${r.cct}`);
  assert.ok(Math.abs(r.lux - 2127.7) < 0.2, `lux exact ${r.lux}`);
  assert.ok(Math.abs(r.duv - -0.0136) < 5e-4, `duv ${r.duv}`);
});

test('LM4 model falls back to spline CRI outside its domain', () => {
  const r = lm4Process([0, 0, 0, 0, 0, 0, 0, 5000, 5000]); // deep-red-only spectrum
  assert.ok(r.lux >= 0);
  assert.ok(['spline', null].includes(r.criSource));
});

test('LM4 battery mapping handles both firmware tables', () => {
  assert.equal(lm4Battery(3344).percent, 100); // old-table firmware, fully charged
  assert.equal(lm4Battery(3027).percent, 1);
  const newFw = lm4Battery(1000); // quarter-mV units -> 4000 mV
  assert.equal(newFw.mv, 4000);
  assert.ok(newFw.percent > 90);
  assert.equal(lm4Battery(0).percent, null);
});

test('CS is bounded and zero at zero lux', () => {
  assert.equal(lm4CircadianStimulus(1, 1, 0), 0);
  const { channels } = lm4Calibrate(LM4_RAW, LM4_K);
  const m = lm4Predict(channels, 4236, 2057);
  const cs = lm4CircadianStimulus(m.a, m.b, 2057);
  assert.ok(cs > 0 && cs <= 0.7);
});

test('processMeasurement wires model-specific pipelines', () => {
  const lm4 = processMeasurement({ model: 'lm4', raw: LM4_RAW, batteryRaw: 3344, temperature: null }, { model: 'lm4', kSensor: LM4_K });
  assert.equal(lm4.model, 'lm4');
  assert.equal(lm4.calibrated, true);
  assert.equal(lm4.battery.percent, 100);
  const f = ref.fixtures[0];
  const lm3 = processMeasurement({ model: 'lm3', raw: f.raw, batteryRaw: 3900, temperature: 24 }, { model: 'lm3', kSensor: f.k });
  assert.equal(lm3.model, 'lm3');
  close(lm3.cct, f.cct, 1e-9, 'lm3 via processMeasurement');
  assert.equal(lm3.temperature, 24);
  const uncal = processMeasurement({ model: 'lm3', raw: f.raw, batteryRaw: 3900, temperature: 24 }, null);
  assert.equal(uncal.calibrated, false);
});

test('standard formulas: McCamy and Ohno on known points', () => {
  // D65 chromaticity -> ~6500 K, Duv ~ +0.003
  const cct = cctFromXy(0.3127, 0.329);
  assert.ok(Math.abs(cct - 6500) < 40, `D65 ${cct}`);
  const [u, v] = xyToUv(0.3127, 0.329);
  const duv = duvFromUv(u, v);
  assert.ok(Math.abs(duv - 0.0032) < 0.001, `D65 duv ${duv}`);
  // Illuminant A (x=0.4476, y=0.4074) -> ~2856 K on the locus
  const a = cctFromXy(0.4476, 0.4074);
  assert.ok(Math.abs(a - 2856) < 30, `Illuminant A ${a}`);
  const [ua, va] = xyToUv(0.4476, 0.4074);
  assert.ok(Math.abs(duvFromUv(ua, va)) < 0.001);
});

test('a Planckian SPD scores CRI 100', () => {
  // Sample Planck at the LM4 bands, reconstruct and check Ra ~ 100 against the Planckian reference.
  const wl = [415, 445, 480, 515, 555, 590, 630, 680];
  const planck = (nm, T) => {
    const l = nm * 1e-9;
    return 1.191027e-16 / (l ** 5 * (Math.exp(0.0143876 / (l * T)) - 1));
  };
  const spd = interpolateSpd(wl, wl.map((n) => planck(n, 2856)));
  const { Ra } = calcCri(2856, spd);
  assert.ok(Ra > 95, `Ra ${Ra}`);
});
