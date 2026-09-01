// Opple Light Master 4 - AS7341 spectral sensor (F1..F8 + clear).
//
// The LM4 does not use the LM3's mode-switched matrices. The official Opple
// app (v3.15.0, coefficient set LightmasterIVCoeff_20231115) maps the eight
// kSensor-calibrated spectral channels to XYZ with a single 3x8 matrix, and
// derives CRI (R1..R14, Ra), EML and circadian stimulus from a degree-3
// polynomial model on a transformed, normalised channel vector. Both were
// extracted from the app by gabrielebaudo/opple-bridge (MIT) and validated
// against app screenshots (see test/colour.test.js).

import { xyzToXy, xyToUv, cctFromXy, duvFromUv, tintFromXy, interpolateSpd, calcCri, batteryFromMv } from './colour.js';
import { LM4_POLY, LM4_POWERS } from './lm4-model-data.js';

export const LM4_WAVELENGTHS = [415, 445, 480, 515, 555, 590, 630, 680];
export const LM4_BAND_LABELS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];

const MATRIX_G4 = [
  [-0.873112331303128, 0.805269469275936, -0.14141487926448, 0.0341236934045446, 0.290053924131123, 0.681542877395036, 0.237949611300369, -0.0216220125618065],
  [-0.892318403241807, 0.283584501574269, -0.142426509016336, 0.670437256572805, 0.619588489202499, 0.436347226426992, 0.0482937353635748, -0.00263886395266582],
  [-1.60374782255152, 3.11179541056893, 0.945597350971534, -0.0788297890447575, 0.103830669638194, -0.0824849988110418, -0.0071035486372898, -0.0659551443269493],
];

const COEFF_MATRIX = [
  [-0.158469, 0.20916, 0.112595, -0.330816, -0.108551, 0.156185, -0.031859, 0.301539],
  [-1.419388, 1.96641, -0.37666, -0.063028, 0.217644, 0.157068, -0.238497, 0.307221],
  [-1.144102, 1.352208, 0.414882, -0.239411, 0.052844, 0.412882, -0.596718, 0.684658],
  [-0.225311, 0.175267, -0.304776, 0.874862, 0.0965, 0.106016, -0.168342, 0.396309],
  [0.254739, -0.063965, 0.223948, -0.295055, 0.721228, -0.009727, 0.196025, 0.190601],
  [0.136996, 0.654563, 0.171631, -0.856572, -0.895806, 1.215222, 0.257699, 0.303073],
  [-0.208297, 1.65795, 0.693002, -2.181311, -2.197116, 1.38897, 1.202967, 0.4825],
  [0.038598, 0.814068, 0.59312, -1.397442, -1.28491, 0.886942, 0.06491, 0.989551],
];

const LED_MIN = [0.05181869, 0.01784572, 0.04740712, 0.04553685, 0.25051674, 0.28267713, 0.17828663, 0.03560036];
const LED_MAX = [0.32746889, 0.73256163, 0.59506801, 0.65308541, 0.72466856, 0.65386043, 0.87034288, 0.54106279];
const AB_MIN = [0.08172532, 0.10375636, 0.07822125, 0.15535571, 0.26380078, 0.29673346, 0.26490609, 0.03563745];
const AB_MAX = [0.12244247, 0.51499119, 0.33630407, 0.40782491, 0.5581059, 0.58960656, 0.68683068, 0.56185695];
const EML_MIN = [0.08177328, 0.10373766, 0.07822311, 0.15534812, 0.26378332, 0.2967478, 0.29495997, 0.036428];
const EML_MAX = [0.12246987, 0.46526904, 0.31737552, 0.40371817, 0.5580768, 0.58961628, 0.68682864, 0.56187936];

export function lm4ChannelsToXyz(ch) {
  const vec = ch.slice(0, 8);
  const dot = (row) => Math.max(0, row.reduce((acc, w, k) => acc + w * vec[k], 0));
  return [dot(MATRIX_G4[0]), dot(MATRIX_G4[1]), dot(MATRIX_G4[2])];
}

function l2(vec) {
  const n = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
  return n === 0 ? vec.slice() : vec.map((v) => v / n);
}

function minMax(vec, lo, hi) {
  return vec.map((v, i) => (hi[i] !== lo[i] ? (v - lo[i]) / (hi[i] - lo[i]) : 0));
}

function polyFeatures(vec) {
  const out = new Array(LM4_POWERS.length);
  for (let t = 0; t < LM4_POWERS.length; t++) {
    const p = LM4_POWERS[t];
    let val = 1;
    for (let i = 0; i < 8; i++) if (p[i] !== 0) val *= vec[i] ** p[i];
    out[t] = val;
  }
  return out;
}

function evaluate(features, key) {
  const { bias, coef } = LM4_POLY[key];
  let r = bias;
  for (let i = 1; i < coef.length; i++) r += coef[i] * features[i];
  return r;
}

/**
 * Opple's LM4 polynomial model: CRI R1..R14 + Ra, melanopic ratio, and the
 * circadian-stimulus coefficients. Returns null when the spectrum falls
 * outside the model's domain (a transformed component <= 0), as the app does.
 */
export function lm4Predict(channels8, cct, lux) {
  if (channels8.length < 8) return null;
  const unit = l2(channels8.slice(0, 8));
  const transformed = COEFF_MATRIX.map((row) => row.reduce((acc, w, k) => acc + w * unit[k], 0));
  if (transformed.some((v) => v <= 0)) return null;
  const base = l2(transformed);

  const ledFeatures = polyFeatures(minMax(base, LED_MIN, LED_MAX));
  const R = [];
  for (let i = 1; i <= 14; i++) R.push(Math.min(evaluate(ledFeatures, `R${i}`), 100));
  const Ra = Math.min(evaluate(ledFeatures, 'Ra'), 100);

  const emlPoly = evaluate(polyFeatures(minMax(base, EML_MIN, EML_MAX)), 'EML');
  const emlRatio = emlPoly > 0 && emlPoly < 1 ? emlPoly : 0.00023846153846153847 * cct - 0.6438461538461538 + 0.45;
  const eml = Math.max(0, emlRatio * lux);

  const abFeatures = polyFeatures(minMax(base, AB_MIN, AB_MAX));
  const a = evaluate(abFeatures, 'A');
  const b = evaluate(abFeatures, 'B');
  return { Ra, R, eml, a, b };
}

/** Circadian stimulus (Rea et al. form used by the Opple app) from the model's a, b and lux. */
export function lm4CircadianStimulus(a, b, lux) {
  const k = lux / 1000;
  const val = a * k * k + b * k;
  if (val < 0) return 0;
  return 0.7 - 0.7 / (1 + (val / 355.7) ** 1.1026);
}

/** Full LM4 pipeline from the nine kSensor-calibrated channels. */
export function lm4Process(channels) {
  const [X, Y, Z] = lm4ChannelsToXyz(channels);
  let [x, y] = xyzToXy(X, Y, Z);
  let u = 0;
  let v = 0;
  if (x !== 0 || y !== 0) [u, v] = xyToUv(x, y);
  if (X === 0 && Y === 0 && Z === 0) {
    x = 0;
    y = 0;
  }
  const lux = Y;
  const cct = cctFromXy(x, y);
  const duv = duvFromUv(u, v);
  const { tint } = tintFromXy(x, y);
  const spd = interpolateSpd(LM4_WAVELENGTHS, channels.slice(0, 8));

  let Ra = null;
  let R = null;
  let eml = null;
  let cs = null;
  let criSource = null;
  if (lux > 0 && Number.isFinite(cct)) {
    const model = lm4Predict(channels, cct, lux);
    if (model) {
      ({ Ra, R, eml } = model);
      cs = lm4CircadianStimulus(model.a, model.b, lux);
      criSource = 'opple-model';
    } else {
      // Outside the app's model domain: fall back to a spline SPD through the eight bands.
      const cri = calcCri(cct, spd);
      Ra = cri.Ra;
      R = cri.R;
      criSource = 'spline';
    }
  }
  return {
    model: 'lm4',
    x,
    y,
    u,
    v,
    lux,
    cct,
    duv,
    tint,
    mode: null,
    modeName: null,
    Ra,
    R,
    criSource,
    eml,
    cs,
    spd,
    bands: channels.slice(0, 8),
    clear: channels[8],
    bandWavelengths: LM4_WAVELENGTHS,
  };
}

export function lm4Calibrate(raw, kSensor) {
  return { channels: raw.slice(0, 9).map((r, i) => r * (kSensor[i] ?? 1)) };
}

// Battery: the app picks one of two tables by firmware version. Older units
// report a direct ADC reading (~3000-3300); newer ones report quarter-mV.
const OLD_TABLE = [3297, 3270, 3243, 3216, 3189, 3162, 3135, 3108, 3081, 3054, 3027];
const PCT = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 1];

export function lm4Battery(batteryRaw) {
  if (!batteryRaw || batteryRaw <= 0) return { mv: null, percent: null };
  if (batteryRaw < 2000) {
    const mv = batteryRaw * 4;
    return { mv, percent: batteryFromMv(mv) };
  }
  const t = OLD_TABLE;
  if (batteryRaw > t[0]) return { mv: null, percent: 100 };
  if (batteryRaw <= t[t.length - 1]) return { mv: null, percent: 1 };
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] >= batteryRaw && batteryRaw > t[i + 1]) {
      const frac = (batteryRaw - t[i + 1]) / (t[i] - t[i + 1]);
      return { mv: null, percent: PCT[i + 1] + frac * (PCT[i] - PCT[i + 1]) };
    }
  }
  return { mv: null, percent: null };
}
