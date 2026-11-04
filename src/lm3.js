// Opple Light Master 3 - six-band sensor (450/500/550/570/600/650 nm).
//
// Raw counts are multiplied by the unit's kSensor calibration (read over
// BLE), classified by source type, and mapped to XYZ with Opple's 3x7
// tristimulus matrices (protocol facts via OlliV/open-light-master). Y is
// illuminance in lux directly.
//
// CRI: the six bands are turned into a full spectrum with a Wiener estimator
// (src/lm3-recon-data.js) and scored with CIE 13.3 against a reference at
// that spectrum's own CCT. The earlier method - a cubic spline through the raw
// band values, scored against the matrix CCT - treated counts as spectral
// power: the bands differ in sensitivity, so the spline came out ~1,500 K
// warmer than the light and every source read Ra ~80 (daylight 79, SL1 79-86
// where a Sekonic C-800 and the LM4 read 95-98).

import { xyzToXy, xyToUv, cctFromXy, duvFromUv, tintFromXy, spdToXyz, calcCri, batteryFromMv } from './colour.js';
import { LM3_RECON_W, LM3_RECON_GAINS } from './lm3-recon-data.js';

export const LM3_WAVELENGTHS = [450, 500, 550, 570, 600, 650];
export const LM3_BAND_LABELS = ['V', 'B', 'G', 'Y', 'O', 'R'];

export const MODE_MONO = 1;
export const MODE_INCANDESCENT = 2;
export const MODE_GENERAL = 3;
export const LM3_MODE_NAMES = { 1: 'monochromatic', 2: 'incandescent', 3: 'general' };

const MATRICES = [
  [
    [0.06023, 0.00106, 0.02108, 0.03673, 0.1683, 0.02001, 0.0],
    [0.00652, 0.04478, 0.16998, -0.03268, 0.07425, 0.00739, 0.0],
    [0.33092, 0.12936, -0.15809, 0.19889, -0.0156, 0.00296, 0.0],
  ],
  [
    [-0.43786, 0.53102, -0.1453, 0.2316, 0.36758, -0.09047, 0.0],
    [-0.23226, 0.69225, -0.39786, 0.22539, 0.47947, -0.17614, 0.0],
    [-0.11002, 1.21259, -0.56003, 0.14487, 0.35074, -0.30248, 0.0],
  ],
  [
    [-0.05825, -0.0896, 0.25859, 0.19518, 0.10893, 0.06724, 0.0],
    [-0.19865, 0.01337, 0.40651, 0.29702, -0.06287, 0.03282, 0.0],
    [0.58258, 0.11548, 0.21823, -0.00136, -0.10732, -0.00915, 0.0],
  ],
];

export function lm3LightMode(ch) {
  const [V, B, G, Y, O, R] = ch;
  const total = V + B + G + Y + O + R;
  if (total <= 0) return MODE_GENERAL;
  const a = (O + R) / total;
  const b = (R - Y) / total;
  if (Math.max(V, B, G, Y, O, R) / total >= 0.45) return MODE_MONO;
  if (a >= 0.5 && a <= 0.55 && b >= 0 && b <= 0.05) return MODE_INCANDESCENT;
  return MODE_GENERAL;
}

export function lm3ChannelsToXyz(ch, c1, mode) {
  const m = MATRICES[mode - 1];
  const vec = [ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], c1];
  const dot = (row) => Math.max(0, row.reduce((acc, w, k) => acc + w * vec[k], 0));
  return [dot(m[0]), dot(m[1]), dot(m[2])];
}

/** Spectrum (380..780 nm, 5 nm, arbitrary scale) reconstructed from the six calibrated bands. */
export function lm3ReconstructSpd(ch) {
  const c = ch.slice(0, 6).map((v, i) => v / LM3_RECON_GAINS[i]);
  return LM3_RECON_W.map((row) => Math.max(0, row.reduce((acc, w, k) => acc + w * c[k], 0)));
}

/** CIE 13.3 CRI of the reconstructed spectrum, referenced at the spectrum's own CCT. Null if it has no usable CCT. */
export function lm3Cri(spd) {
  if (!spd.some((v) => v > 0)) return null;
  const [X, Y, Z] = spdToXyz(spd);
  const [x, y] = xyzToXy(X, Y, Z);
  const cct = cctFromXy(x, y);
  if (!Number.isFinite(cct) || cct < 1000 || cct > 25000) return null;
  return calcCri(cct, spd);
}

/** Equivalent melanopic lux estimate (Opple's LM3 fit). */
export function lm3Eml(cct, ch, mode) {
  const [v, b, g, y, o, r] = ch;
  let eml;
  if (cct < 4e3) {
    if (cct < 3e3 && mode === MODE_INCANDESCENT) {
      eml = -11.1321 * v + 10.088 * b + 10.5399 * g - 4.9714 * y - 4.2457 * o + 1.3921 * r;
    } else {
      eml = 0.1157 * v + 0.543 * b + 0.1886 * g + 0.02516 * y - 0.0825 * o - 0.007316 * r;
    }
  } else {
    eml = -0.005224 * v + 0.3113 * b + 0.3649 * g + 0.3632 * y - 0.4313 * o + 0.05123 * r;
  }
  return Math.max(0, eml);
}

/**
 * Full LM3 pipeline from calibrated channels (raw x kSensor[0..5]) and the
 * constant input c1 (= kSensor[6]).
 */
export function lm3Process(channels, c1) {
  const mode = lm3LightMode(channels);
  const [X, Y, Z] = lm3ChannelsToXyz(channels, c1, mode);
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
  const spd = lm3ReconstructSpd(channels);
  let cri = null;
  let eml = null;
  if (lux > 0 && Number.isFinite(cct)) {
    cri = lm3Cri(spd);
    eml = lm3Eml(cct, channels, mode);
  }
  return {
    model: 'lm3',
    x,
    y,
    u,
    v,
    lux,
    cct,
    duv,
    tint,
    mode,
    modeName: LM3_MODE_NAMES[mode],
    Ra: cri ? cri.Ra : null,
    R: cri ? cri.R : null,
    criSource: cri ? 'reconstruction' : null,
    eml,
    cs: null,
    spd,
    bands: channels.slice(),
    bandWavelengths: LM3_WAVELENGTHS,
  };
}

/** Apply the unit calibration to a raw LM3 measurement. */
export function lm3Calibrate(raw, kSensor) {
  const channels = raw.slice(0, 6).map((r, i) => r * kSensor[i]);
  return { channels, c1: 1 * kSensor[6] };
}

export function lm3Battery(batteryRaw) {
  return { mv: batteryRaw, percent: batteryFromMv(batteryRaw) };
}
