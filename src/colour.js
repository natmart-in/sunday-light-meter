// Colorimetry shared by both meters: chromaticity, CCT, Duv, tint, SPD
// reconstruction, CRI (CIE 13.3-1995), battery mapping and display helpers.
//
// The maths follows the standard formulas (McCamy 1992, Ohno 2014 / ANSI
// C78.377, CIE 13.3, DNG-style tint) and matches the Sunday CCT bench's
// Python port of open-light-master to ~1e-12 (see test/colour.test.js).

import { CMF_1931_2DEG, CIE_D_S, TCS, TINT_TABLE, N_WL, WL_START, WL_STEP } from './cie-data.js';

// ---------------------------------------------------------------------------
// Chromaticity spaces
// ---------------------------------------------------------------------------

export function xyzToXy(X, Y, Z) {
  const s = X + Y + Z;
  return s === 0 ? [0, 0] : [X / s, Y / s];
}

/** CIE 1931 xy -> CIE 1960 UCS (u, v). Duv is defined in this space. */
export function xyToUv(x, y) {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

export function uvToXy(u, v) {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/** CIE 1964 U*V*W* relative to a reference white (u0, v0). */
export function xyzToUvw(XYZ, u0, v0) {
  const [x, y] = xyzToXy(XYZ[0], XYZ[1], XYZ[2]);
  const [u, v] = xyToUv(x, y);
  const W = 25 * Math.cbrt(XYZ[1]) - 17;
  return [13 * W * (u - u0), 13 * W * (v - v0), W];
}

// ---------------------------------------------------------------------------
// CCT (McCamy 1992) and Duv (Ohno 2014 polynomial, ANSI C78.377)
// ---------------------------------------------------------------------------

export function cctFromXy(x, y) {
  if (y === 0.1858) return NaN;
  const n = (x - 0.332) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

const DUV_K = [-0.471106, 1.925865, -2.4243787, 1.5317403, -0.5179722, 0.0893944, -0.00616793];

/** Signed distance from the Planckian locus in CIE 1960 uv. Positive = above (green), negative = below (magenta). */
export function duvFromUv(u, v) {
  const lfp = Math.hypot(u - 0.292, v - 0.24);
  if (lfp === 0) return 0;
  const a = Math.acos((u - 0.292) / lfp);
  let lbb = 0;
  for (let i = 0; i < 7; i++) lbb += DUV_K[i] * a ** i;
  return lfp - lbb;
}

// ---------------------------------------------------------------------------
// Tint (DNG-style walk along the Wyszecki & Stiles Planckian table)
// ---------------------------------------------------------------------------

const TINT_SCALE = -3000.0;

export function tintFromXy(x, y) {
  const u = (2.0 * x) / (1.5 - x + 6.0 * y);
  const v = (3.0 * y) / (1.5 - x + 6.0 * y);
  let temperature = NaN;
  let tint = NaN;
  let lastDt = 0;
  let lastDv = 0;
  let lastDu = 0;
  for (let i = 1; i <= 30; i++) {
    let du = 1.0;
    let dv = TINT_TABLE[i][3];
    let len = Math.sqrt(1.0 + dv * dv);
    du /= len;
    dv /= len;
    let uu = u - TINT_TABLE[i][1];
    let vv = v - TINT_TABLE[i][2];
    let dt = -uu * dv + vv * du;
    if (dt <= 0.0 || i === 30) {
      if (dt > 0.0) dt = 0.0;
      dt = -dt;
      const f = i === 1 ? 0.0 : dt / (lastDt + dt);
      temperature = 1.0e6 / (TINT_TABLE[i - 1][0] * f + TINT_TABLE[i][0] * (1.0 - f));
      uu = u - (TINT_TABLE[i - 1][1] * f + TINT_TABLE[i][1] * (1.0 - f));
      vv = v - (TINT_TABLE[i - 1][2] * f + TINT_TABLE[i][2] * (1.0 - f));
      du = du * (1.0 - f) + lastDu * f;
      dv = dv * (1.0 - f) + lastDv * f;
      len = Math.sqrt(du * du + dv * dv);
      du /= len;
      dv /= len;
      tint = (uu * du + vv * dv) * TINT_SCALE;
      break;
    }
    lastDt = dt;
    lastDu = du;
    lastDv = dv;
  }
  return { temperature, tint };
}

// ---------------------------------------------------------------------------
// Natural cubic spline (as used by open-light-master for SPD reconstruction)
// ---------------------------------------------------------------------------

export class Spline {
  constructor(xs, ys) {
    this.xs = xs.slice();
    this.ys = ys.slice();
    this.ks = this.naturalKs();
  }

  naturalKs() {
    const { xs, ys } = this;
    const n = xs.length - 1;
    const A = Array.from({ length: n + 1 }, () => new Array(n + 2).fill(0));
    for (let i = 1; i < n; i++) {
      A[i][i - 1] = 1 / (xs[i] - xs[i - 1]);
      A[i][i] = 2 * (1 / (xs[i] - xs[i - 1]) + 1 / (xs[i + 1] - xs[i]));
      A[i][i + 1] = 1 / (xs[i + 1] - xs[i]);
      A[i][n + 1] = 3 * ((ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]) ** 2 + (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) ** 2);
    }
    A[0][0] = 2 / (xs[1] - xs[0]);
    A[0][1] = 1 / (xs[1] - xs[0]);
    A[0][n + 1] = (3 * (ys[1] - ys[0])) / (xs[1] - xs[0]) ** 2;
    A[n][n - 1] = 1 / (xs[n] - xs[n - 1]);
    A[n][n] = 2 / (xs[n] - xs[n - 1]);
    A[n][n + 1] = (3 * (ys[n] - ys[n - 1])) / (xs[n] - xs[n - 1]) ** 2;
    return Spline.solve(A, n + 1);
  }

  static solve(A, m) {
    let h = 0;
    let k = 0;
    while (h < m && k <= m) {
      let iMax = h;
      let vMax = -Infinity;
      for (let i = h; i < m; i++) {
        const val = Math.abs(A[i][k]);
        if (val > vMax) {
          iMax = i;
          vMax = val;
        }
      }
      if (A[iMax][k] === 0) {
        k++;
      } else {
        [A[h], A[iMax]] = [A[iMax], A[h]];
        for (let i = h + 1; i < m; i++) {
          const f = A[i][k] / A[h][k];
          A[i][k] = 0;
          for (let j = k + 1; j <= m; j++) A[i][j] -= A[h][j] * f;
        }
        h++;
        k++;
      }
    }
    const ks = new Array(m).fill(0);
    for (let i = m - 1; i >= 0; i--) {
      const v = A[i][i] ? A[i][m] / A[i][i] : 0;
      ks[i] = v;
      for (let j = i - 1; j >= 0; j--) {
        A[j][m] -= A[j][i] * v;
        A[j][i] = 0;
      }
    }
    return ks;
  }

  indexBefore(target) {
    const { xs } = this;
    let low = 0;
    let high = xs.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (xs[mid] < target && mid !== low) low = mid;
      else if (xs[mid] >= target && mid !== high) high = mid;
      else high = low;
    }
    if (low === xs.length - 1) return xs.length - 1;
    return low + 1;
  }

  at(x) {
    const { xs, ys, ks } = this;
    const i = this.indexBefore(x);
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    const a = ks[i - 1] * (xs[i] - xs[i - 1]) - (ys[i] - ys[i - 1]);
    const b = -ks[i] * (xs[i] - xs[i - 1]) + (ys[i] - ys[i - 1]);
    return (1 - t) * ys[i - 1] + t * ys[i] + t * (1 - t) * (a * (1 - t) + b * t);
  }
}

// ---------------------------------------------------------------------------
// SPD helpers (380..780 nm, 5 nm grid)
// ---------------------------------------------------------------------------

/** Interpolate sparse sensor bands onto the 5 nm grid: 0 at 380 nm, last value held out to 780 nm. */
export function interpolateSpd(wavelengths, values) {
  const xs = wavelengths.slice();
  const ys = values.slice();
  if (xs[0] > WL_START) {
    xs.unshift(WL_START);
    ys.unshift(0);
  }
  if (xs[xs.length - 1] < 780) {
    xs.push(780);
    ys.push(ys[ys.length - 1]);
  }
  const s = new Spline(xs, ys);
  const out = new Array(N_WL);
  for (let i = 0; i < N_WL; i++) out[i] = s.at(WL_START + WL_STEP * i);
  return out;
}

export function spdToXyz(spd) {
  let xs = 0;
  let ys = 0;
  let zs = 0;
  for (let i = 0; i < spd.length; i++) {
    xs += spd[i] * CMF_1931_2DEG[i * 3];
    ys += spd[i] * CMF_1931_2DEG[i * 3 + 1];
    zs += spd[i] * CMF_1931_2DEG[i * 3 + 2];
  }
  return [(100 * xs) / ys, 100, (100 * zs) / ys];
}

export function normalizeSpd(spd) {
  const c = spd[36]; // 560 nm
  return spd.map((v) => v / c);
}

export function spdOfPlanck(cct) {
  const out = new Array(N_WL);
  for (let i = 0; i < N_WL; i++) {
    const wl = (WL_START + WL_STEP * i) * 1e-9;
    out[i] = 1.191027e-16 / (wl ** 5 * (Math.exp(0.0143876 / (wl * cct)) - 1));
  }
  return out;
}

export function spdOfD(cct) {
  const xlo = -4.607e9 / cct ** 3 + 2.9678e6 / cct ** 2 + 0.09911e3 / cct + 0.244063;
  const xhi = 2.0064e9 / cct ** 3 + 1.9018e6 / cct ** 2 + 0.24748e3 / cct + 0.23704;
  const xd = cct < 7000 ? xlo : xhi;
  const yd = -3 * xd ** 2 + 2.87 * xd - 0.275;
  const m1 = (-1.3515 - 1.7703 * xd + 5.9114 * yd) / (0.0241 + 0.2562 * xd - 0.7341 * yd);
  const m2 = (0.03 - 31.4424 * xd + 30.0717 * yd) / (0.0241 + 0.2562 * xd - 0.7341 * yd);
  const out = new Array(N_WL);
  for (let i = 0; i < N_WL; i++) out[i] = CIE_D_S[i * 3] + m1 * CIE_D_S[i * 3 + 1] + m2 * CIE_D_S[i * 3 + 2];
  return out;
}

// ---------------------------------------------------------------------------
// CRI - CIE 13.3-1995 test colour method (Ra + R1..R14)
// ---------------------------------------------------------------------------

function uvToCd(u, v) {
  return [(4 - u - 10 * v) / v, (1.708 * v + 0.404 - 1.481 * u) / v];
}

function tcsXyz(spd, sample) {
  let xs = 0;
  let ys = 0;
  let zs = 0;
  let yIllum = 0;
  for (let i = 0; i < spd.length; i++) {
    xs += spd[i] * sample[i] * CMF_1931_2DEG[i * 3];
    ys += spd[i] * sample[i] * CMF_1931_2DEG[i * 3 + 1];
    zs += spd[i] * sample[i] * CMF_1931_2DEG[i * 3 + 2];
    yIllum += spd[i] * CMF_1931_2DEG[i * 3 + 1];
  }
  return [(100 * xs) / yIllum, (100 * ys) / yIllum, (100 * zs) / yIllum];
}

/** CRI of a test SPD (81 values at 5 nm) against Planck (<5000 K) or D-illuminant. */
export function calcCri(cct, testSpd) {
  const ref = normalizeSpd(cct < 5000 ? spdOfPlanck(cct) : spdOfD(cct));
  const refXYZ = spdToXyz(ref);
  const [rx, ry] = xyzToXy(refXYZ[0], refXYZ[1], refXYZ[2]);
  const [ru, rv] = xyToUv(rx, ry);
  const [cr, dr] = uvToCd(ru, rv);
  const refUVW = TCS.map((s) => xyzToUvw(tcsXyz(ref, s), ru, rv));

  const test = normalizeSpd(testSpd);
  const testXYZ = spdToXyz(test);
  const [tx, ty] = xyzToXy(testXYZ[0], testXYZ[1], testXYZ[2]);
  const [ut, vt] = xyToUv(tx, ty);
  const [ct, dt] = uvToCd(ut, vt);
  const uat = (10.872 + 0.404 * (cr / ct) * ct - 4 * (dr / dt) * dt) / (16.518 + 1.481 * (cr / ct) * ct - (dr / dt) * dt);
  const vat = 5.52 / (16.518 + 1.481 * (cr / ct) * ct - (dr / dt) * dt);

  const R = TCS.map((s, i) => {
    const XYZ = tcsXyz(test, s);
    const [x, y] = xyzToXy(XYZ[0], XYZ[1], XYZ[2]);
    const [u, v] = xyToUv(x, y);
    const [cs, ds] = uvToCd(u, v);
    const uas = (10.872 + 0.404 * (cr / ct) * cs - 4 * (dr / dt) * ds) / (16.518 + 1.481 * (cr / ct) * cs - (dr / dt) * ds);
    const vas = 5.52 / (16.518 + 1.481 * (cr / ct) * cs - (dr / dt) * ds);
    const W = 25 * Math.cbrt(XYZ[1]) - 17;
    const U = 13 * W * (uas - uat);
    const V = 13 * W * (vas - vat);
    const [Ur, Vr, Wr] = refUVW[i];
    const de = Math.sqrt((Ur - U) ** 2 + (Vr - V) ** 2 + (Wr - W) ** 2);
    return 100 - 4.6 * de;
  });
  const Ra = R.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
  return { Ra, R };
}

// ---------------------------------------------------------------------------
// Battery (Li-ion pack mV -> %), shared by LM3 and newer-firmware LM4
// ---------------------------------------------------------------------------

const BAT_MV = [4080, 3985, 3894, 3838, 3773, 3725, 3710, 3688, 3656, 3594, 3455];
const BAT_PCT = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 1];

export function batteryFromMv(mv) {
  let level = 1;
  for (let i = 0; i < 9; i++) {
    if (mv > BAT_MV[i + 1]) {
      level = ((mv - BAT_MV[i + 1]) / (BAT_MV[i] - BAT_MV[i + 1])) * (BAT_PCT[i] - BAT_PCT[i + 1]) + BAT_PCT[i + 1];
      break;
    }
  }
  return Math.min(level, 100);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Approximate sRGB of a blackbody at `kelvin` (Tanner Helland fit), as a CSS colour. */
export function cctToCss(kelvin) {
  const k = Math.min(12000, Math.max(1200, kelvin)) / 100;
  let r;
  let g;
  let b;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (k - 60) ** -0.1332047592;
    g = 288.1221695283 * (k - 60) ** -0.0755148492;
    b = 255;
  }
  const c = (v) => Math.round(Math.min(255, Math.max(0, v)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/** Approximate sRGB of a visible wavelength (nm) for spectrum bars. */
export function wavelengthToCss(nm) {
  let r = 0;
  let g = 0;
  let b = 0;
  if (nm >= 380 && nm < 440) {
    r = -(nm - 440) / 60;
    b = 1;
  } else if (nm < 490) {
    g = (nm - 440) / 50;
    b = 1;
  } else if (nm < 510) {
    g = 1;
    b = -(nm - 510) / 20;
  } else if (nm < 580) {
    r = (nm - 510) / 70;
    g = 1;
  } else if (nm < 645) {
    r = 1;
    g = -(nm - 645) / 65;
  } else if (nm <= 780) {
    r = 1;
  }
  let f = 1;
  if (nm < 420) f = 0.3 + (0.7 * (nm - 380)) / 40;
  else if (nm > 700) f = 0.3 + (0.7 * (780 - nm)) / 80;
  const c = (v) => Math.round(255 * (v * f) ** 0.8);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}
