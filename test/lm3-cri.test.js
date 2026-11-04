// Light Master 3 CRI: spectrum reconstruction (src/lm3-recon-data.js) instead of a
// spline through the raw bands. Two kinds of check:
//   1. Real frames from both meters side by side on the bench (4 Nov 2026): the
//      LM3 must now agree with the LM4's Opple model and with a Sekonic C-800
//      reading of the same lamp type, and its spectrum must agree with its own
//      colour matrix.
//   2. CIE standard sources run through the AS7262 datasheet responsivity: the
//      estimate must track the true CIE 13.3 Ra across good and poor sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseMeasurement, parseCalibration } from '../src/protocol.js';
import { processMeasurement } from '../src/meter.js';
import { lm3ReconstructSpd, lm3Cri, lm3SpdLux, lm3Process, lm3LightMode, LM3_WAVELENGTHS, MODE_INCANDESCENT } from '../src/lm3.js';
import { LM3_RECON_GAINS, LM3_RECON_W } from '../src/lm3-recon-data.js';
import { CMF_1931_2DEG } from '../src/cie-data.js';
import { calcCri, cctFromXy, interpolateSpd, spdOfD, spdOfPlanck, spdToXyz, xyzToXy } from '../src/colour.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

const bench = fixture('bench-2026-11-04.json');
const cal3 = parseCalibration(hex(bench.calibration.lm3));
const cal4 = parseCalibration(hex(bench.calibration.lm4));
const readings = bench.points.map((p) => ({
  label: p.label,
  lm3: processMeasurement(parseMeasurement(hex(p.lm3)), cal3),
  lm4: processMeasurement(parseMeasurement(hex(p.lm4)), cal4),
}));

const spdCct = (spd) => {
  const [X, Y, Z] = spdToXyz(spd);
  return cctFromXy(...xyzToXy(X, Y, Z));
};

test('reconstruction data has the expected shape', () => {
  assert.equal(LM3_RECON_GAINS.length, 6);
  assert.equal(LM3_RECON_W.length, 81);
  LM3_RECON_W.forEach((row) => assert.equal(row.length, 6));
});

test('bench fixture decodes as one LM3 and one LM4', () => {
  assert.equal(cal3.model, 'lm3');
  assert.equal(cal4.model, 'lm4');
  for (const r of readings) {
    assert.equal(r.lm3.model, 'lm3');
    assert.equal(r.lm4.model, 'lm4');
  }
});

test('real bench frames: LM3 Ra now agrees with the LM4 and the Sekonic (was ~80)', () => {
  for (const { label, lm3, lm4 } of readings) {
    assert.equal(lm3.criSource, 'reconstruction');
    assert.ok(lm3.Ra >= 93 && lm3.Ra <= 99, `${label}: LM3 Ra ${lm3.Ra.toFixed(1)}`);
    // The LM4 model itself reads ~2-3 above the Sekonic on this lamp (98.1 vs 95.2 near 4000 K).
    assert.ok(Math.abs(lm3.Ra - lm4.Ra) <= 4, `${label}: LM3 Ra ${lm3.Ra.toFixed(1)} vs LM4 ${lm4.Ra.toFixed(1)}`);
  }
  // Sekonic C-800 on an SL1 at 3982 K: Ra 95.2, R9 81.5.
  const at4000 = readings.find((r) => r.label === '4000 K').lm3;
  assert.ok(Math.abs(at4000.Ra - 95.2) <= 2, `4000 K Ra ${at4000.Ra}`);
  assert.ok(Math.abs(at4000.R[8] - 81.5) <= 10, `4000 K R9 ${at4000.R[8]}`);
});

test('real bench frames: the two meters agree on CCT', () => {
  for (const { label, lm3, lm4 } of readings) {
    assert.ok(Math.abs(lm3.cct - lm4.cct) <= 150, `${label}: LM3 ${lm3.cct.toFixed(0)} K vs LM4 ${lm4.cct.toFixed(0)} K`);
  }
});

test('real bench frames: the reconstructed spectrum matches the LM3 colour matrix', () => {
  // The gains were set from daylight only, so agreement under the LED is an independent check.
  for (const { label, lm3 } of readings) {
    const c = spdCct(lm3.spd);
    assert.ok(Math.abs(c - lm3.cct) <= 150, `${label}: spectrum ${c.toFixed(0)} K vs matrix ${lm3.cct.toFixed(0)} K`);
  }
});

test('the old spline method is what read low (regression note)', () => {
  // A spline through the band values scored against the matrix CCT - the pre-Nov-2026 method.
  for (const { label, lm3 } of readings) {
    const old = calcCri(lm3.cct, interpolateSpd(LM3_WAVELENGTHS, lm3.bands)).Ra;
    assert.ok(old < 87, `${label}: old Ra ${old.toFixed(1)}`);
  }
});

// --- simulated meter on CIE standard sources ------------------------------------

const resp = fixture('as7262-response.json').channels;
const sensor = ['V', 'B', 'G', 'Y', 'O', 'R'].map((c) => resp[c]);
const simulate = (spd) => sensor.map((r, i) => LM3_RECON_GAINS[i] * r.reduce((acc, v, j) => acc + v * spd[j], 0));
const trueCri = (spd) => calcCri(spdCct(spd), spd);

const sources = fixture('cie-test-sources.json');
const cases = [
  ['Planck 2856 K (illuminant A)', spdOfPlanck(2856), 5],
  ['CIE D50', spdOfD(5003), 4],
  ['CIE D65', spdOfD(6504), 3],
  ['CIE F2', sources['CIE F2'], 5],
  ['CIE F7', sources['CIE F7'], 4],
  ['CIE F11', sources['CIE F11'], 4],
  ['CIE LED-B1', sources['CIE LED-B1'], 4],
  ['CIE LED-B3', sources['CIE LED-B3'], 4],
  ['CIE LED-B4', sources['CIE LED-B4'], 4],
  ['CIE LED-B5', sources['CIE LED-B5'], 5],
  ['CIE LED-BH1', sources['CIE LED-BH1'], 6],
  ['CIE LED-RGB1', sources['CIE LED-RGB1'], 6],
  ['CIE LED-V1', sources['CIE LED-V1'], 3],
  ['CIE LED-V2', sources['CIE LED-V2'], 3],
];

test('simulated LM3 tracks true Ra on CIE standard sources', () => {
  for (const [name, spd, tol] of cases) {
    const truth = trueCri(spd).Ra;
    const est = lm3Cri(lm3ReconstructSpd(simulate(spd))).Ra;
    assert.ok(Math.abs(est - truth) <= tol, `${name}: estimate ${est.toFixed(1)} vs true ${truth.toFixed(1)}`);
  }
});

test('simulated LM3 orders good and poor sources correctly', () => {
  const est = (spd) => lm3Cri(lm3ReconstructSpd(simulate(spd))).Ra;
  assert.ok(est(spdOfD(6504)) > est(sources['CIE LED-B3']) + 10);
  assert.ok(est(sources['CIE LED-V2']) > est(sources['CIE F2']) + 25);
});

test('lm3Cri returns null for an empty spectrum', () => {
  assert.equal(lm3Cri(new Array(81).fill(0)), null);
});

// --- lux -----------------------------------------------------------------------

test('real bench frames: LM3 lux is anchored to the Opple matrix at 4000 K', () => {
  const r = readings.find((p) => p.label === '4000 K').lm3;
  assert.equal(r.luxSource, 'reconstruction');
  assert.ok(Math.abs(r.lux / r.luxMatrix - 1) < 0.002, `lux ${r.lux} vs matrix ${r.luxMatrix}`);
});

test('real bench frames: LM3 lux now follows warm-to-cool changes like the LM4 (was +7 % / -6 %)', () => {
  // Daylight subtracted, each meter relative to its own 4000 K reading. On the bench the LM4 and a
  // Yocto-Light-V5 agreed within 1 % on these ratios; Opple's LM3 matrix did not.
  const day = readings.find((p) => p.label === 'daylight');
  const ref = readings.find((p) => p.label === '4000 K');
  const rel = (p, m, key) => (p[m][key] - day[m][key]) / (ref[m][key] - day[m][key]);
  for (const label of ['2700 K', '6500 K']) {
    const p = readings.find((q) => q.label === label);
    const lm4 = rel(p, 'lm4', 'lux');
    const fixed = rel(p, 'lm3', 'lux');
    const matrix = rel(p, 'lm3', 'luxMatrix');
    assert.ok(Math.abs(fixed / lm4 - 1) < 0.02, `${label}: LM3 ${fixed.toFixed(3)} vs LM4 ${lm4.toFixed(3)}`);
    assert.ok(Math.abs(matrix / lm4 - 1) > 0.04, `${label}: matrix ${matrix.toFixed(3)} (regression note)`);
  }
});

test('simulated LM3 lux tracks true lux across CIE LED and fluorescent sources', () => {
  // Scale-free check: estimated / true lux should be the same for every source.
  const names = ['CIE F2', 'CIE F7', 'CIE F11', 'CIE LED-B1', 'CIE LED-B2', 'CIE LED-B3', 'CIE LED-B4', 'CIE LED-B5', 'CIE LED-BH1', 'CIE LED-V1', 'CIE LED-V2'];
  const trueY = (spd) => spd.reduce((acc, v, i) => acc + v * CMF_1931_2DEG[i * 3 + 1], 0);
  const ratios = names.map((n) => [n, lm3SpdLux(lm3ReconstructSpd(simulate(sources[n]))) / trueY(sources[n])]);
  const sorted = ratios.map((r) => r[1]).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  // Narrowband tri-phosphor fluorescent (F11) is the hard case for six broad bands: ~6 %.
  for (const [n, r] of ratios) {
    const tol = n === 'CIE F11' ? 0.07 : 0.03;
    assert.ok(Math.abs(r / med - 1) < tol, `${n}: ${((r / med - 1) * 100).toFixed(1)} %`);
  }
});

test('incandescent-mode readings keep the Opple matrix lux', () => {
  const ch = [4, 10, 15, 22, 26, 27];
  assert.equal(lm3LightMode(ch), MODE_INCANDESCENT);
  const r = lm3Process(ch, 1);
  assert.equal(r.luxSource, 'opple-matrix');
  assert.equal(r.lux, r.luxMatrix);
});
