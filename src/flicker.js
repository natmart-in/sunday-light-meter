// Opple Light Master 3 / 4 - flicker (temporal modulation) capture and analysis.
//
// The meters can dump a 1024-sample waveform of the light hitting the sensor
// (opcode REQ_FREQ 0x0A0A -> RES_FREQ 0x0A0B). From it we get percent
// modulation depth, flicker index, the fundamental flicker frequency, and an
// IEEE PAR-1789-2015 risk zone.
//
// Two things make this different from a normal measurement:
//
//   1. The response is CHUNKED - four pages, each its own notification, that
//      must be written into a shared 1024-sample buffer. The single
//      request/response path in meter.js cannot express that, so this module
//      owns the reassembly (FlickerAssembler) and meter.js routes RES_FREQ
//      messages into it.
//   2. The sampling rate is not fixed. The request carries a `period` byte
//      that picks one of three hardware sampling modes, each with its own
//      time base. One mode cannot resolve both 100 Hz PWM and 30 kHz supply
//      ripple, so the Opple app runs a three-stage cascade (see
//      FLICKER_PERIODS and the cascade in meter.js).
//
// Sources, all reverse-engineered - no Opple documentation exists:
//   - LM3 chunk layout, wave unpacking, DC offsets, the sort-based modulation
//     metric: OlliV/open-light-master (lib/ble/lm3.ts parseWave, lib/flicker.ts).
//   - LM4 chunk layout, LM4 DC offsets, the period cascade and its thresholds:
//     gabrielebaudo/opple-bridge (ble/parser.py, science/flicker.py,
//     ble/manager.py), transcribed from the decompiled Opple app.
//
// Every constant below that differs between the two meters is marked. If a
// number here is wrong, modulation depth is the metric that shows it first:
// a wrong DC offset makes a flicker-free light read tens of percent.

import { HEADER_LEN } from './protocol.js';

export const FLICKER_SAMPLES = 1024;
export const FLICKER_PAGES = 4;
/** Samples one full page carries; page N is written at page * this offset. */
export const FLICKER_PAGE_STRIDE = 260;

const GROUPS_FULL = 65; // pages 0-2: 65 groups of 6 bytes -> 260 samples
const GROUPS_LAST = 61; // page 3:    61 groups            -> 244 samples (3*260 + 244 = 1024)

/**
 * Byte offset of the packed waveform inside the message payload.
 *
 * This is the one layout difference between the meters: the LM4 carries eight
 * more metadata bytes ahead of the samples. LM3 = 17 (open-light-master reads
 * from msg[12] + 16), LM4 = 25 (opple-bridge reads payload[25:]).
 */
export const WAVE_OFFSET = { lm3: 17, lm4: 25 };

/**
 * Sampling modes. The request body carries the period; the device answers with
 * a waveform sampled at 1024^2 / timeFactor Hz. `timeFactor` is not a physical
 * constant - it is the divisor the Opple app uses in `freq = bin * 1024 /
 * factor`, re-cast here so the ordinary `bin * fs / N` works unchanged.
 */
export const FLICKER_PERIODS = {
  broad: 25, //  ~40 kHz sampling - covers 50 Hz to 20 kHz, the default first pass
  fine: 146, //  ~7 kHz  sampling - resolution for mains-frequency PWM
  fast: 11, //   ~85 kHz sampling - switching ripple above 15 kHz
};

const TIME_FACTOR = { 25: 26.0, 146: 150.0, 11: 12.285 };
const DEFAULT_PERIOD = FLICKER_PERIODS.broad;

/**
 * Cascade thresholds. The fine pass exists for LOW frequencies - its 6.8 Hz
 * bins are what tell 100 Hz from 120 Hz, and its 3.5 kHz Nyquist cannot see
 * anything faster. The fast pass exists for the top of the range. Escalating
 * to fine for a >2 kHz reading (an earlier draft did) hands back an ALIAS:
 * a true 13.7 kHz ripple folds to a confident-looking ~270 Hz.
 */
export const REFINE_BELOW_HZ = 2000;
export const CONFIRM_ABOVE_HZ = 15000;

/**
 * Per-range ADC baseline that must be subtracted before any analysis.
 *
 * The device reports a range byte (0-2) with each chunk; each range sits on a
 * different DC pedestal. Skip this and the smallest samples never reach zero,
 * so modulation depth blows up (opple-bridge measured ~56% instead of ~1%) and
 * the DFT dumps its energy into bin 0, leaking into bin 1 and making the peak
 * finder return a spurious ~39 Hz.
 *
 * LM3 values: open-light-master lib/flicker.ts. LM4 values: opple-bridge
 * science/flicker.py. They are genuinely different numbers, not a copy - do
 * not share one table between the models.
 */
const DC_OFFSET = {
  lm3: [67.003906, 35.363281, 34.516602],
  lm4: [29.7412109375, 15.8720703125, 13.8447265625],
};

/** Sampling rate in Hz for a period byte. */
export function sampleRateFor(period) {
  const factor = TIME_FACTOR[period] || TIME_FACTOR[DEFAULT_PERIOD];
  return (FLICKER_SAMPLES * FLICKER_SAMPLES) / factor;
}

/** Body of a REQ_FREQ command: [reserved, period high byte, period low byte]. */
export function flickerBody(period = DEFAULT_PERIOD) {
  return new Uint8Array([0x00, (period >> 8) & 0xff, period & 0xff]);
}

/**
 * Parse one RES_FREQ chunk. Layout after the 11-byte inner header:
 *   [0]      unused
 *   [1]      page index 0-3 (3 is the last)
 *   [2]      range - selects the DC offset above
 *   [3..]    chunk metadata, WAVE_OFFSET[model] bytes in total from [0]
 *   [off..]  samples packed 4-per-6-bytes, 12 bits each, big-endian
 * Returns null if the chunk is unusable.
 */
export function parseFlickerChunk(msg, model = 'lm4') {
  if (!msg || msg.length < HEADER_LEN + 4) return null;
  const p = msg.subarray(HEADER_LEN);
  const page = p[1];
  if (page >= FLICKER_PAGES) return null;
  const offset = WAVE_OFFSET[model] ?? WAVE_OFFSET.lm4;
  // The meter sends a FIXED-SIZE payload for every page (415 B on the LM4), so
  // the last page carries a full 65 groups too - the final 16 samples are
  // padding past the 1024 the capture actually holds, and the assembler drops
  // them. Assuming a short last page is what produced a permanent, misleading
  // "24 spare bytes - readings may be wrong" on every single capture
  // (hardware, 2026-09-01). Take what is actually there.
  const avail = Math.floor((p.length - offset) / 6);
  const groups = Math.min(GROUPS_FULL, avail);
  if (groups < GROUPS_LAST) return null;
  const wave = p.subarray(offset);
  if (wave.length < groups * 6) return null;

  const samples = new Array(groups * 4);
  for (let i = 0; i < groups; i++) {
    const o = 6 * i;
    const a = (wave[o] << 8) | wave[o + 1];
    const b = (wave[o + 2] << 8) | wave[o + 3];
    const c = (wave[o + 4] << 8) | wave[o + 5];
    samples[4 * i] = a >> 4;
    samples[4 * i + 1] = ((a & 0x0f) << 8) | (b >> 8);
    samples[4 * i + 2] = ((b & 0xff) << 4) | (c >> 12);
    samples[4 * i + 3] = c & 0xfff;
  }
  // `slack` is how many payload bytes are left over after the samples. It is 0
  // when WAVE_OFFSET is right for this firmware and non-zero when it is not,
  // which is the single most useful number to have in a bug report.
  return { page, range: p[2], samples, offset, payloadLength: p.length, slack: p.length - offset - groups * 6 };
}

/** Collects the four chunks of one capture into a single 1024-sample waveform. */
export class FlickerAssembler {
  constructor(model = 'lm4') {
    this.model = model;
    this.reset();
  }

  reset() {
    this.waveform = new Array(FLICKER_SAMPLES).fill(0);
    this.pages = new Set();
    this.range = 2;
    this.slack = null;
  }

  /** Feed a RES_FREQ message. Returns the finished capture, or null if more pages are due. */
  feed(msg) {
    const chunk = parseFlickerChunk(msg, this.model);
    if (!chunk) return null;
    const base = chunk.page * FLICKER_PAGE_STRIDE;
    for (let i = 0; i < chunk.samples.length; i++) {
      const idx = base + i;
      if (idx < FLICKER_SAMPLES) this.waveform[idx] = chunk.samples[i];
    }
    this.pages.add(chunk.page);
    this.range = chunk.range;
    this.slack = chunk.slack;
    if (this.pages.size < FLICKER_PAGES) return null;
    const out = { waveform: this.waveform, range: this.range, model: this.model, slack: this.slack };
    this.reset();
    return out;
  }
}

/** Subtract the range's DC pedestal and half-wave rectify, as the Opple app does. */
export function acCouple(waveform, range, model = 'lm4') {
  const table = DC_OFFSET[model] || DC_OFFSET.lm4;
  const dc = table[range] ?? table[table.length - 1];
  return waveform.map((s) => (s > dc ? s - dc : 0));
}

/**
 * Percent modulation depth, time domain, on the AC-coupled wave:
 *   (mean of largest 30 - mean of smallest 30) / (their sum) * 100
 * The 30-sample averaging is what makes it robust to single-sample spikes;
 * both reference implementations use this rather than an FFT-derived depth.
 * Capped at 99.5 like the app.
 */
export function modulationDepth(coupled) {
  if (!coupled || coupled.length < 60) return 0;
  const sorted = coupled.slice().sort((a, b) => a - b);
  const n = Math.min(30, sorted.length);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    lo += sorted[i];
    hi += sorted[sorted.length - 1 - i];
  }
  lo /= n;
  hi /= n;
  if (hi + lo <= 0) return 0;
  return Math.min(99.5, Math.max(0, ((hi - lo) / (hi + lo)) * 100));
}

/** Rea's flicker index on the AC-coupled wave: area above the mean / total area. 0-1. */
export function flickerIndex(coupled) {
  if (!coupled || coupled.length < 8) return 0;
  let total = 0;
  for (const s of coupled) total += s;
  if (total <= 0) return 0;
  const mean = total / coupled.length;
  let above = 0;
  for (const s of coupled) if (s > mean) above += s - mean;
  return above / total;
}

/**
 * Magnitude spectrum of a real signal, radix-2 Cooley-Tukey. Length must be a
 * power of two; returns the first N/2 bins including DC.
 *
 * No window is applied - deliberately. The reference pipeline applies none,
 * and windowing the DC-laden wave was the bug that made opple-bridge's peak
 * finder always answer ~39 Hz.
 */
export function magnitudeSpectrum(signal) {
  const n = signal.length;
  if (n < 2 || (n & (n - 1)) !== 0) return [];
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  const half = n / 2;
  const mag = new Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n;
  return mag;
}

/** Index of the largest bin, ignoring DC. Returns 0 when there is nothing to find. */
export function peakBin(mag) {
  if (!mag || mag.length < 2) return 0;
  let best = 1;
  for (let i = 2; i < mag.length; i++) if (mag[i] > mag[best]) best = i;
  return best;
}

// -- Is there anything there at all? ----------------------------------------
//
// peakBin() ALWAYS returns a bin. Point the meter at the sun - a genuinely
// flicker-free source - and the AC-coupled trace is nothing but sensor noise,
// yet the peak finder still names a frequency and modulationDepth() still
// returns a few tenths of a percent. Reported as-is that reads like a real
// measurement of a real flicker. Pointed at the sun, this returned ~0.3%.
//
// The fix is a detection test BEFORE anything is reported: compare the peak
// bin against the spectrum's own noise floor. The floor is the MEDIAN bin, not
// the mean - a median is unmoved by the one or two large bins a real flicker
// puts there, so it estimates the noise even when a strong signal is present.
//
// Threshold: for pure white noise the largest of N Rayleigh-distributed bins
// sits around 3x the median (N = 512 here). 6x is comfortably above what noise
// alone produces and still well below any genuine flicker, which typically
// runs 20x or more.

export const DETECT_SNR = 6;

/**
 * Modulation depth that counts as real flicker on its own, whatever the
 * spectrum looks like.
 *
 * The SNR test alone is not enough: a source with 5-10% messy ripple came
 * back "flicker-free" under an SNR-only gate. SNR asks "is the energy concentrated at one
 * frequency?", which is the wrong question for flicker that is broadband,
 * drifting, or spread across many harmonics - all of which are real flicker a
 * person can see. PAR-1789 itself is written in terms of modulation depth, not
 * spectral purity, so depth gets its own route to "detected".
 *
 * 1.0% sits above the meter's own noise (a flicker-free source reads 0.15-0.3%)
 * and far below anything a person would argue about. This is an INSTRUMENT
 * limit, not a physical claim: below it we cannot tell, so we say so.
 */
export const DETECT_DEPTH_PCT = 1.0;

/**
 * ON-level (ADC counts) below which a capture is "too dim" to trust.
 *
 * This is measured on the LIT part of the waveform, not on its mean - see
 * onLevel(). Gating on the mean was a real bug: a light that switches fully off
 * spends part of every cycle at zero, so its mean is duty x peak. A 50%-duty
 * source needed twice the brightness of a steady one to be measured, a 10%-duty
 * one ten times, and below that the app answered "too little light - no flicker
 * detected" for a light that was visibly strobing at ~100% depth. The dimmer
 * the gate thought the light was, the deeper the flicker actually was.
 */
export const LOW_SIGNAL_COUNTS = 50;

/**
 * The other end of the same problem: the ADC ceiling.
 *
 * The sensor is 12-bit, so a sample can never exceed 4095 counts no matter how
 * bright the light is. Bring a flickering lamp close enough and the lit part of
 * every cycle pins there while the dark part keeps rising, so the measured
 * contrast COLLAPSES as the light gets brighter - a 90%-modulated lamp reads
 * 87%, then 75%, then 35%, and once even the dark part clears full scale the
 * waveform is a flat line and the app says "no flicker".
 *
 * It is the exact mirror of the LOW_SIGNAL_COUNTS bug and it fails the same
 * dangerous way: silently, toward "everything is fine".
 *
 * A clipped capture is not a measurement, but it is not worthless either -
 * clipping only ever REDUCES apparent depth, so the number it yields is a
 * lower bound. That asymmetry is the whole rule: a saturated capture can still
 * damn a lamp, it can never clear one.
 *
 * Threshold: samples within 10 counts of full scale, on the RAW waveform (the
 * ceiling lives there - AC coupling moves the floor, not the top). 2% of the
 * window, so the 1-2-sample spike trains that a narrow-duty strobe legitimately
 * produces are not mistaken for a clipped plateau.
 */
export const FULL_SCALE_COUNTS = 4095;
export const SATURATION_COUNTS = FULL_SCALE_COUNTS - 10;
export const SATURATION_FRACTION = 0.02;

/** Share of RAW samples pinned at (or within noise of) the ADC ceiling. */
export function saturatedFraction(waveform) {
  if (!waveform || !waveform.length) return 0;
  let n = 0;
  for (const s of waveform) if (s >= SATURATION_COUNTS) n++;
  return n / waveform.length;
}

/**
 * How far above the DC pedestal the light sits when it is ON: the MEDIAN of the
 * five largest AC-coupled samples.
 *
 * Averaging a fixed count (30 was the first attempt) is still duty-dependent in
 * disguise. A driver that fires a 2-sample spike every 170 samples only puts
 * ~12 lit samples in the whole 1024-sample window, so a mean over 30 is 18
 * zeros deep and reads a third of the truth - and a strobe that narrow is the
 * most severe flicker the meter can see. A median over 5 needs only three lit
 * samples in the entire capture, which any real flicker clears, while still
 * ignoring the one or two hot noise samples a plain max() would chase.
 */
export function onLevel(coupled) {
  if (!coupled || !coupled.length) return 0;
  const sorted = coupled.slice().sort((a, b) => a - b);
  const n = Math.min(5, sorted.length);
  const top = sorted.slice(sorted.length - n);
  return top[(n - 1) >> 1];
}

/**
 * Frequency from the TIME domain: the median spacing between rising edges.
 *
 * The spectrum cannot answer this one. A narrow pulse train is close to an
 * impulse train, whose energy is spread flat across every harmonic, so no
 * single bin stands above the noise floor and the SNR gate correctly refuses to
 * name a frequency - leaving a 100%-modulated strobe reported as "no single
 * peak, risk not assessed". But the pulses themselves are unmistakable in the
 * raw trace, and their spacing IS the frequency.
 *
 * Returns null unless there are at least three edges and their spacings agree
 * to within 20%, so a ragged or drifting driver still falls through to
 * "broadband" rather than being handed a confident wrong number.
 */
export function pulseFrequency(coupled, sampleRate) {
  const level = onLevel(coupled);
  if (!(level > 0) || !(sampleRate > 0)) return null;
  const gate = level * 0.5;
  const edges = [];
  let above = coupled[0] > gate;
  for (let i = 1; i < coupled.length; i++) {
    const now = coupled[i] > gate;
    if (now && !above) edges.push(i);
    above = now;
  }
  if (edges.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < edges.length; i++) gaps.push(edges[i] - edges[i - 1]);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  if (!(median > 0)) return null;
  for (const g of gaps) if (Math.abs(g - median) > 0.2 * median) return null;
  return sampleRate / median;
}

/** Median magnitude excluding DC - a noise-floor estimate that survives a real peak. */
export function noiseFloor(mag) {
  if (!mag || mag.length < 4) return 0;
  const rest = mag.slice(1).sort((a, b) => a - b);
  const mid = rest.length >> 1;
  return rest.length % 2 ? rest[mid] : (rest[mid - 1] + rest[mid]) / 2;
}

/** How many times the noise floor the peak stands at. Infinity when the floor is 0. */
export function peakSnr(mag, bin) {
  if (!mag || !mag[bin]) return 0;
  const floor = noiseFloor(mag);
  return floor > 0 ? mag[bin] / floor : Infinity;
}

// -- What KIND of flicker is it? --------------------------------------------
//
// "Flicker" covers two physically different things and the distinction changes
// what you do about it:
//
//   PWM / dimming      - the driver switches the LED fully off and on. The
//                        waveform is flat-topped with hard edges, so it is rich
//                        in harmonics and a real fraction of samples sit near
//                        zero. This is the kind that causes stroboscopic
//                        effects and is a design choice we can change.
//   Ripple             - the supply never switches off, it just wobbles. Close
//                        to a sine, few harmonics, no samples near zero. Either
//                        MAINS ripple at twice line frequency (100/120 Hz,
//                        an under-filtered rectifier) or SWITCHING ripple in
//                        the tens of kHz (normal, benign, above human vision).
//
// Two cheap measures separate them, both from data already computed:
//   zeroFraction  - share of samples below 10% of peak. PWM has an off period;
//                   a ripple waveform never goes near zero.
//   harmonicRatio - energy in harmonics 2-5 relative to the fundamental. A
//                   square wave is harmonic-rich; a sine is not.

export const FLICKER_KIND_LABEL = {
  none: 'No flicker detected',
  pwm: 'PWM / dimming',
  'mains-ripple': 'Mains ripple',
  ripple: 'Supply ripple',
  // Real, measurable modulation with no single frequency behind it - a noisy or
  // drifting driver. Named rather than forced into one of the others, because
  // "we can see it but cannot name one frequency" is a genuine third answer.
  broadband: 'Irregular / broadband',
};

/** Share of samples below 10% of the largest - PWM's off period shows up here. */
export function zeroFraction(coupled) {
  if (!coupled || !coupled.length) return 0;
  const max = Math.max(...coupled);
  if (!(max > 0)) return 0;
  const gate = max * 0.1;
  let n = 0;
  for (const s of coupled) if (s < gate) n++;
  return n / coupled.length;
}

/** Energy in harmonics 2-5 of the peak bin, relative to the peak itself. */
export function harmonicRatio(mag, bin) {
  if (!mag || !bin || !(mag[bin] > 0)) return 0;
  let sum = 0;
  // Above a quarter of Nyquist the harmonics fall off the spectrum, so this
  // returns 0 for fast PWM - zeroFraction is the only PWM evidence up there.
  for (let h = 2; h <= 5; h++) {
    const k = bin * h;
    if (k >= mag.length) break;
    // Take the strongest of the three bins around the harmonic: the fundamental
    // rarely lands exactly on a bin centre, so its harmonics land off-centre
    // too. Never let the window reach back to the fundamental itself - at
    // bin 1 the second harmonic's left neighbour IS the peak.
    sum += Math.max(k - 1 > bin ? mag[k - 1] || 0 : 0, mag[k], mag[k + 1] || 0);
  }
  return sum / mag[bin];
}

/**
 * Classify a capture. Order matters: nothing detected wins over everything, and
 * the PWM test runs before the mains test because plenty of cheap drivers PWM
 * at exactly 120 Hz - the waveform shape, not the frequency, is what says
 * whether the LED is being switched off.
 */
export function classifyFlicker({ detected, frequencyConfident = true, frequency, zeroFrac, harmonics }) {
  if (!detected) return 'none';
  if (zeroFrac > 0.1 || harmonics > 0.35) return 'pwm';
  if (!frequencyConfident) return 'broadband';
  if (frequency >= 90 && frequency <= 130) return 'mains-ripple';
  return 'ripple';
}

// -- IEEE PAR-1789-2015 -----------------------------------------------------
// Two straight lines with a floor below 10 Hz:
//   no risk  : modulation % <= 0.033 * max(10, f)
//   low risk : modulation % <= 0.080 * max(10, f)
// Above ~3 kHz the no-risk line exceeds 100%, so any real light is no-risk on
// frequency alone. That is why "N times under the limit" is a meaningless
// claim up there and only the measured pair (depth AND frequency) should be
// quoted.

export function riskLimits(frequencyHz) {
  const f = Math.max(10, frequencyHz || 0);
  return { noRisk: 0.033 * f, lowRisk: 0.08 * f };
}

export function assessRisk(frequencyHz, modulationPct) {
  // No frequency, no verdict. Both boundaries are functions of frequency, so a
  // capture with real depth and no frequency cannot be cleared - and answering
  // "No risk" there is the worst possible default: it is exactly the reading a
  // deep, messy, genuinely risky flicker produces. Say we could not assess it.
  if (!(frequencyHz > 0)) return modulationPct >= DETECT_DEPTH_PCT ? 'unknown' : 'no-risk';
  if (!(modulationPct > 0)) return 'no-risk';
  const { noRisk, lowRisk } = riskLimits(frequencyHz);
  if (modulationPct <= noRisk) return 'no-risk';
  if (modulationPct <= lowRisk) return 'low-risk';
  return 'high-risk';
}

export const RISK_LABEL = { 'no-risk': 'No risk', 'low-risk': 'Low risk', 'high-risk': 'High risk', unknown: 'Not assessed' };

/**
 * The PAR-1789 recommended-practice figure itself, as SVG markup for a
 * `viewBox="0 0 480 292"`: frequency (log, 1 Hz - 100 kHz) against percent
 * modulation, split by the two boundary lines, with one capture plotted on it.
 *
 * Worth drawing rather than only printing the "No risk" label, because it shows
 * what the label hides: the boundaries RISE with frequency, so a reading that
 * would be alarming at 100 Hz is unremarkable at 10 kHz. The no-risk line
 * crosses 100% modulation at ~3.0 kHz, above which every physically possible
 * reading is no-risk on frequency alone - the chart makes that visible instead
 * of letting a high-frequency pass look like a quality result.
 *
 * Pure and DOM-free so it can be unit-tested and rendered headlessly. It reads
 * the same riskLimits() the badge does, so the dot can never disagree with the
 * label beside it.
 *
 * @param result - an analyseFlicker() result, or null/undefined for an empty chart
 */
export function riskChartSvg(result) {
  const x0 = 46;
  const x1 = 456;
  const y0 = 14;
  const y1 = 226;
  const F_MIN = 1;
  const F_MAX = 1e5;
  const lx0 = Math.log10(F_MIN);
  const lspan = Math.log10(F_MAX) - lx0;
  const X = (hz) => x0 + ((Math.log10(Math.max(F_MIN, Math.min(F_MAX, hz))) - lx0) / lspan) * (x1 - x0);
  const Y = (pct) => y1 - (Math.max(0, Math.min(100, pct)) / 100) * (y1 - y0);

  // Sample each boundary in log space. 10 Hz is included exactly because that
  // is where the flat floor kinks into the linear part.
  const freqs = [F_MIN, 10];
  for (let i = 0; i <= 120; i++) freqs.push(10 ** (lx0 + (i / 120) * lspan));
  freqs.push(F_MAX);
  freqs.sort((a, b) => a - b);
  const line = (slope) => freqs.map((hz) => `${X(hz).toFixed(1)},${Y(slope * Math.max(10, hz)).toFixed(1)}`).join(' ');
  const band = (slope) => `${X(F_MIN).toFixed(1)},${Y(0).toFixed(1)} ${line(slope)} ${X(F_MAX).toFixed(1)},${Y(0).toFixed(1)}`;

  // Painted back to front: high-risk fills the plot, low-risk covers it up to
  // the 0.080 line, no-risk up to the 0.033 line.
  const zones = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#c0392b" fill-opacity="0.16"/>
    <polygon points="${band(0.08)}" fill="#e8a33a" fill-opacity="0.45"/>
    <polygon points="${band(0.033)}" fill="#3a9d5d" fill-opacity="0.45"/>
    <polyline points="${line(0.08)}" fill="none" stroke="#b07a1e" stroke-width="1.2"/>
    <polyline points="${line(0.033)}" fill="none" stroke="#2b7346" stroke-width="1.2"/>`;

  const hzLabel = (hz) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);
  const xAxis = [1, 10, 100, 1000, 10000, 100000]
    .map(
      (hz) =>
        `<line x1="${X(hz).toFixed(1)}" x2="${X(hz).toFixed(1)}" y1="${y0}" y2="${y1}" stroke="currentColor" stroke-opacity="0.18"/>` +
        `<text x="${X(hz).toFixed(1)}" y="${y1 + 15}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.7">${hzLabel(hz)}</text>`,
    )
    .join('');
  const yAxis = [0, 25, 50, 75, 100]
    .map(
      (pct) =>
        `<line x1="${x0}" x2="${x1}" y1="${Y(pct).toFixed(1)}" y2="${Y(pct).toFixed(1)}" stroke="currentColor" stroke-opacity="0.18"/>` +
        `<text x="${x0 - 6}" y="${(Y(pct) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity="0.7">${pct}</text>`,
    )
    .join('');

  // The measured point. Frequency is only ever known to a bin width, so the
  // horizontal whisker is the honest width of this reading, not decoration.
  // A capture with real depth but no clean peak still belongs ON the chart -
  // dropping it reads as "flicker-free", which is the opposite of true.
  // It is drawn hollow at the best-guess frequency to say the
  // height is measured but the horizontal position is not to be trusted.
  let marker = '';
  const plotHz = result && (result.frequency > 0 ? result.frequency : result.detected ? result.peakFrequency : 0);
  if (plotHz > 0) {
    const unsure = !result.frequency;
    const px = X(plotHz);
    const py = Y(result.modulationDepth);
    const res = result.resolution || 0;
    const lo = X(Math.max(F_MIN, plotHz - res / 2));
    const hi = X(plotHz + res / 2);
    marker = `<line x1="${lo.toFixed(1)}" x2="${hi.toFixed(1)}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" stroke="#292524" stroke-width="1.2"/>
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="${unsure ? 'none' : '#e86b3a'}" stroke="#292524" stroke-width="1.4"${unsure ? ' stroke-dasharray="2 2"' : ''}/>
      <text x="${(px > x1 - 90 ? px - 9 : px + 9).toFixed(1)}" y="${Math.max(py - 8, y0 + 10).toFixed(1)}" text-anchor="${px > x1 - 90 ? 'end' : 'start'}" font-size="10" font-weight="600" fill="currentColor">${unsure ? 'this light (frequency uncertain)' : 'this light'}</text>`;
  }

  const legend = `<g font-size="10" fill="currentColor" fill-opacity="0.8">
    <rect x="${x0}" y="266" width="9" height="9" fill="#3a9d5d" fill-opacity="0.6"/><text x="${x0 + 13}" y="274">No risk</text>
    <rect x="${x0 + 66}" y="266" width="9" height="9" fill="#e8a33a" fill-opacity="0.6"/><text x="${x0 + 79}" y="274">Low risk</text>
    <rect x="${x0 + 140}" y="266" width="9" height="9" fill="#c0392b" fill-opacity="0.3"/><text x="${x0 + 153}" y="274">High risk</text>
    <text x="${x1}" y="274" text-anchor="end" fill-opacity="0.6">IEEE PAR-1789-2015</text>
  </g>`;

  return `${zones}${xAxis}${yAxis}
    <rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="currentColor" stroke-opacity="0.35"/>
    ${marker}
    <text x="${(x0 + x1) / 2}" y="${y1 + 31}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.7">Flicker frequency (Hz)</text>
    <text x="13" y="${(y0 + y1) / 2}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.7" transform="rotate(-90 13 ${(y0 + y1) / 2})">Modulation (%)</text>
    ${legend}`;
}

/**
 * Turn a finished capture into the numbers a person reads.
 *
 * @param capture - a finished FlickerAssembler result: waveform, range, model
 * @param {number} period - the period byte the capture was requested with
 */
export function analyseFlicker(capture, period = DEFAULT_PERIOD) {
  const { waveform, range, model, slack = 0 } = capture;

  // Is the per-range DC pedestal even credible for this capture?
  //
  // The pedestal is meant to be the sensor's dark offset, so the light must sit
  // ABOVE it. On a dim source it does not: a real capture at 7 lx came back
  // with raw samples of 10-32 counts against a range-0 pedestal of 29.74, so
  // the half-wave clip flattened ~everything to zero and left only the handful
  // of samples poking over 29.74 - drawing a dramatic spike train out of what
  // is actually smooth sensor noise, and computing 99.5% depth from it. The
  // spikes were an artefact of subtracting more than the signal, not flicker.
  //
  // If the pedestal reaches the MEDIAN of the waveform it cannot be a dark
  // offset (most of the capture would be darker than dark), so fall back to the
  // waveform's own floor and say the pedestal is not trustworthy here.
  const sortedRaw = waveform.slice().sort((a, b) => a - b);
  const rawMedian = sortedRaw[sortedRaw.length >> 1];
  const table = DC_OFFSET[model] || DC_OFFSET.lm4;
  const tableDc = table[range] ?? table[table.length - 1];
  // Both clauses matter. A deep PWM source legitimately has a median BELOW the
  // pedestal - the median is its off level - so the median test alone would
  // wrongly distrust exactly the strongest flicker there is (it broke the
  // narrow-pulse-train case first time round). The second clause is what
  // separates them: real flicker climbs far above the dark offset when it is
  // on, whereas a capture whose brightest sample never reaches 3x the dark
  // offset never got a real signal at all.
  const pedestalSuspect = tableDc >= rawMedian && sortedRaw[sortedRaw.length - 1] < 3 * tableDc;
  const coupled = pedestalSuspect ? waveform.map((s) => Math.max(0, s - sortedRaw[0])) : acCouple(waveform, range, model);
  const sampleRate = sampleRateFor(period);
  const resolution = sampleRate / waveform.length;

  // Too little light and the AC-coupling clamp fabricates flicker: when the
  // raw samples straddle the DC pedestal, the half-wave clip pins the low
  // samples to zero and a mildly modulated dim lamp reads near 100% depth.
  // 50 ADC counts (full scale 4095) is the floor below which no depth figure
  // from this pipeline deserves to be believed - measured on the ON level, so
  // that a light which switches fully off is not mistaken for a dim one.
  const on = onLevel(coupled);
  const lowSignal = on < LOW_SIGNAL_COUNTS;

  // And too MUCH light clips the top of every cycle against the 12-bit ceiling,
  // shrinking the measured contrast as the lamp gets brighter until the trace
  // is flat. See SATURATION_COUNTS: the depth that survives is a lower bound.
  const satFrac = saturatedFraction(waveform);
  const saturated = satFrac >= SATURATION_FRACTION;

  const depth = modulationDepth(coupled);
  const index = flickerIndex(coupled);
  const mag = magnitudeSpectrum(coupled);
  const bin = peakBin(mag);

  // Detection gate first. Below it there is no frequency to report - a number
  // read off noise is worse than no number, because it looks like a result.
  //
  // TWO independent routes, either sufficient. Depth catches real flicker whose
  // energy is smeared (broadband, drifting, harmonic-rich); SNR catches a
  // shallow but perfectly coherent tone that depth alone would dismiss. Requiring
  // BOTH dismisses real, visible flicker that lacks a clean peak.
  const snr = peakSnr(mag, bin);
  const depthDetected = depth >= DETECT_DEPTH_PCT;
  const detected = !lowSignal && (depthDetected || snr >= DETECT_SNR);
  // The frequency is a separate question from whether flicker exists: a capture
  // can have unmistakable depth and still not have one clean peak to name.
  const spectralConfident = !lowSignal && snr >= DETECT_SNR;
  const peakFrequency = bin * resolution; // always available; may be meaningless
  // Second route to a frequency, for the waveform the spectrum cannot help
  // with: a narrow pulse train, whose energy is spread flat over its harmonics.
  // Only consulted when the spectrum has already declined, so it can never
  // override a clean tone.
  const timed = !lowSignal && detected && !spectralConfident ? pulseFrequency(coupled, sampleRate) : null;
  const frequencyConfident = spectralConfident || timed !== null;
  const frequencySource = spectralConfident ? 'spectrum' : timed !== null ? 'timing' : 'none';
  const frequency = spectralConfident ? peakFrequency : (timed ?? 0);
  // Above ~80% of this mode's Nyquist a reading is as likely to be an alias of
  // something faster as the real thing.
  const nearNyquist = frequency > 0.8 * (sampleRate / 2);
  const zeroFrac = zeroFraction(coupled);
  // Only meaningful against a spectral peak: when the frequency came from pulse
  // timing, `bin` is whichever harmonic happened to win, and its "harmonics"
  // are noise. The off period (zeroFraction) is the PWM evidence there.
  const harmonics = spectralConfident ? harmonicRatio(mag, bin) : 0;

  // Clipping only ever shrinks apparent depth, so a saturated capture may still
  // convict a lamp - but it must never acquit one. "No risk" off a clipped
  // trace is the same silent-toward-fine failure the flat waveform already is.
  // Note there is no `detected` condition here: a FULLY clipped trace is a flat
  // line, which reads as "no flicker" - the worst version of this failure. A
  // pinned ADC carries no information about what is happening underneath it, so
  // "we could not assess this" is the only honest answer either way.
  const rawRisk = assessRisk(frequency, depth);
  const risk = saturated && rawRisk === 'no-risk' ? 'unknown' : rawRisk;

  // The raw span, before any coupling. This is the diagnostic that separates
  // "the sensor ran out of headroom" from "the meter handed us a flat
  // waveform": pinned at the ceiling means clipping, flat in the middle of the
  // scale means the flatness came from the device, not from our arithmetic.
  let rawMin = Infinity;
  let rawMax = -Infinity;
  for (const s of waveform) {
    if (s < rawMin) rawMin = s;
    if (s > rawMax) rawMax = s;
  }

  return {
    ts: Date.now(),
    detected,
    lowSignal,
    saturated,
    saturatedFraction: satFrac,
    // True when the range's DC pedestal is as large as the signal itself, so
    // the usual coupling would manufacture a spike train out of noise.
    pedestalSuspect,
    rawMin,
    rawMax,
    rawMedian,
    // Non-zero slack means the sample window is in the wrong place for this
    // firmware, so every number here is suspect - it travels with the result
    // rather than living only in a log line nobody exports.
    slack,
    onLevel: on,
    frequencyConfident,
    frequencySource,
    peakFrequency,
    nearNyquist,
    snr,
    kind: classifyFlicker({ detected, frequencyConfident, frequency, zeroFrac, harmonics }),
    zeroFraction: zeroFrac,
    harmonicRatio: harmonics,
    model,
    period,
    range,
    sampleRate,
    // Bin spacing: the frequency is only ever known to +/- half of this, which
    // matters most in the broad mode where it is about 39 Hz.
    resolution,
    windowMs: (waveform.length / sampleRate) * 1000,
    modulationDepth: depth,
    flickerIndex: index,
    frequency,
    peakBin: bin,
    risk,
    limits: riskLimits(frequency),
    waveform,
    coupled,
    magnitudes: mag,
  };
}

/**
 * Which period to try next: broad first, always. A low reading earns a fine
 * pass (resolution), a very high reading earns a fast pass (headroom); the
 * middle of the range is broad's home ground and needs no second pass.
 * Returns null when the cascade is done.
 */
export function nextPeriod(done, results) {
  if (!done.includes(FLICKER_PERIODS.broad)) return FLICKER_PERIODS.broad;
  const broad = results[FLICKER_PERIODS.broad];
  if (!broad || broad.detected === false || !(broad.frequency > 0)) return null;
  if (broad.frequency <= REFINE_BELOW_HZ && !done.includes(FLICKER_PERIODS.fine)) return FLICKER_PERIODS.fine;
  if (broad.frequency > CONFIRM_ABOVE_HZ && !done.includes(FLICKER_PERIODS.fast)) return FLICKER_PERIODS.fast;
  return null;
}

/**
 * Pick the winner of a finished cascade, with one safety net: **a pass that
 * detected nothing can never beat a pass that detected flicker.** Without it,
 * an escalation pass that sampled at the wrong rate for the light in front of
 * it could hand back its empty result over the broad pass's real one.
 */
export function bestResult(results) {
  const broad = results[FLICKER_PERIODS.broad];
  const fine = results[FLICKER_PERIODS.fine];
  const fast = results[FLICKER_PERIODS.fast];

  const preferred = (() => {
    if (!broad) return fine || fast || null;
    // Low frequency: the fine pass's 6.8 Hz bins beat broad's 39 Hz ones.
    if (broad.frequency > 0 && broad.frequency <= REFINE_BELOW_HZ && fine && fine.detected) return fine;
    // Top of the range: keep the fast pass only if it confirms a fast reading.
    if (broad.frequency > CONFIRM_ABOVE_HZ && fast && fast.detected && fast.frequency > CONFIRM_ABOVE_HZ) return fast;
    return broad;
  })();
  if (!preferred || preferred.detected !== false) return preferred;

  const witnesses = [broad, fine, fast].filter((r) => r && r.detected);
  if (!witnesses.length) return preferred;
  return witnesses.sort((a, b) => b.modulationDepth - a.modulationDepth)[0];
}
