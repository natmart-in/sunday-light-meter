import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLICKER_SAMPLES,
  FLICKER_PAGE_STRIDE,
  FLICKER_PERIODS,
  WAVE_OFFSET,
  sampleRateFor,
  flickerBody,
  parseFlickerChunk,
  FlickerAssembler,
  acCouple,
  modulationDepth,
  flickerIndex,
  magnitudeSpectrum,
  peakBin,
  assessRisk,
  riskLimits,
  analyseFlicker,
  nextPeriod,
  riskChartSvg,
  noiseFloor,
  peakSnr,
  zeroFraction,
  harmonicRatio,
  classifyFlicker,
  DETECT_SNR,
  DETECT_DEPTH_PCT,
  bestResult,
  pulseFrequency,
  onLevel,
  saturatedFraction,
  FULL_SCALE_COUNTS,
  SATURATION_FRACTION,
} from '../src/flicker.js';

const HEADER = [0x00, 0x13, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x0b];

/** Build a RES_FREQ chunk the way the meter would: 12-bit samples, 4 per 6 bytes. */
function makeChunk(page, range, samples, model) {
  const offset = WAVE_OFFSET[model];
  const groups = samples.length / 4;
  const bytes = [...HEADER, 0x00, page, range, ...new Array(offset - 3).fill(0)];
  for (let i = 0; i < groups; i++) {
    const [x0, x1, x2, x3] = samples.slice(4 * i, 4 * i + 4).map((v) => Math.max(0, Math.min(0xfff, Math.round(v))));
    const a = (x0 << 4) | (x1 >> 8);
    const b = ((x1 & 0xff) << 8) | (x2 >> 4);
    const c = ((x2 & 0x0f) << 12) | x3;
    bytes.push(a >> 8, a & 0xff, b >> 8, b & 0xff, c >> 8, c & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** Split a 1024-sample waveform into the four chunks the meter sends. */
function makeChunks(waveform, range, model) {
  return [0, 1, 2, 3].map((page) => {
    const n = page === 3 ? 244 : FLICKER_PAGE_STRIDE;
    return makeChunk(page, range, waveform.slice(page * FLICKER_PAGE_STRIDE, page * FLICKER_PAGE_STRIDE + n), model);
  });
}

test('the request body carries the period big-endian', () => {
  assert.deepEqual(Array.from(flickerBody(25)), [0, 0, 25]);
  assert.deepEqual(Array.from(flickerBody(146)), [0, 0, 146]);
  assert.deepEqual(Array.from(flickerBody(300)), [0, 1, 44]);
});

test('sample rate follows the period time base', () => {
  assert.equal(Math.round(sampleRateFor(25)), 40330);
  assert.equal(Math.round(sampleRateFor(146)), 6991);
  assert.equal(Math.round(sampleRateFor(11)), 85354);
  // Unknown period falls back to the broad mode rather than dividing by zero.
  assert.equal(sampleRateFor(99), sampleRateFor(25));
});

test('12-bit sample unpacking round-trips, per model offset', () => {
  for (const model of ['lm3', 'lm4']) {
    const samples = Array.from({ length: 260 }, (_, i) => (i * 7) % 4096);
    const chunk = parseFlickerChunk(makeChunk(0, 1, samples, model), model);
    assert.equal(chunk.page, 0);
    assert.equal(chunk.range, 1);
    assert.equal(chunk.slack, 0, `${model}: wave offset should consume the whole payload`);
    assert.deepEqual(chunk.samples, samples);
  }
});

test('reading an LM4 chunk with the LM3 offset is detectable, not silent', () => {
  const samples = Array.from({ length: 260 }, () => 1000);
  const chunk = parseFlickerChunk(makeChunk(0, 2, samples, 'lm4'), 'lm3');
  assert.notEqual(chunk.slack, 0);
});

test('the assembler returns nothing until all four pages arrive', () => {
  const wave = Array.from({ length: FLICKER_SAMPLES }, (_, i) => i % 4096);
  const asm = new FlickerAssembler('lm4');
  const chunks = makeChunks(wave, 2, 'lm4');
  assert.equal(asm.feed(chunks[0]), null);
  assert.equal(asm.feed(chunks[2]), null);
  assert.equal(asm.feed(chunks[1]), null);
  const done = asm.feed(chunks[3]);
  assert.ok(done);
  assert.equal(done.waveform.length, FLICKER_SAMPLES);
  assert.deepEqual(done.waveform, wave);
  assert.equal(done.range, 2);
  // Reset after delivery, so a second capture starts clean.
  assert.equal(asm.pages.size, 0);
});

test('AC coupling subtracts the range baseline and clips, per model', () => {
  assert.deepEqual(acCouple([0, 20, 100], 0, 'lm4'), [0, 0, 100 - 29.7412109375]);
  assert.deepEqual(acCouple([0, 20, 100], 0, 'lm3'), [0, 0, 100 - 67.003906]);
  // Ranges past the table fall back to the last entry rather than NaN.
  assert.deepEqual(acCouple([100], 9, 'lm4'), [100 - 13.8447265625]);
});

test('a steady light reads ~0% modulation, a fully switched one reads high', () => {
  const steady = new Array(1024).fill(500);
  assert.equal(modulationDepth(acCouple(steady, 2, 'lm4')), 0);
  assert.ok(flickerIndex(acCouple(steady, 2, 'lm4')) < 1e-9);

  const square = Array.from({ length: 1024 }, (_, i) => (i % 2 ? 1000 : 0));
  const md = modulationDepth(acCouple(square, 2, 'lm4'));
  assert.ok(md > 99, `expected near-full modulation, got ${md}`);
});

test('the DC pedestal is what makes a low-flicker light read low', () => {
  // A 1% ripple sitting on the range-2 pedestal. Skipping AC coupling is the
  // classic bug: the metric then reads a few tenths of a percent of the *raw*
  // value and the frequency peak collapses into bin 1.
  const raw = Array.from({ length: 1024 }, (_, i) => 100 + 1 * Math.sin((2 * Math.PI * 64 * i) / 1024));
  const coupled = acCouple(raw, 2, 'lm4');
  const withCoupling = modulationDepth(coupled);
  const withoutCoupling = modulationDepth(raw);
  assert.ok(withCoupling > withoutCoupling * 1.05, `coupling should raise the measured depth (${withoutCoupling} -> ${withCoupling})`);
  assert.equal(peakBin(magnitudeSpectrum(coupled)), 64);
});

test('the spectrum finds a known tone and ignores DC', () => {
  const n = 1024;
  const wave = Array.from({ length: n }, (_, i) => 500 + 200 * Math.sin((2 * Math.PI * 120 * i) / n));
  const mag = magnitudeSpectrum(wave);
  assert.equal(mag.length, n / 2);
  assert.equal(peakBin(mag), 120);
  assert.equal(magnitudeSpectrum([1, 2, 3]).length, 0); // not a power of two
});

test('IEEE PAR-1789 zones sit on the two published lines', () => {
  // Below 10 Hz the limits are flat: 0.33% and 0.8%.
  assert.deepEqual(riskLimits(1), { noRisk: 0.033 * 10, lowRisk: 0.08 * 10 });
  assert.equal(assessRisk(100, 3.0), 'no-risk'); //  limit 3.3%
  assert.equal(assessRisk(100, 5.0), 'low-risk'); // limit 8.0%
  assert.equal(assessRisk(100, 12.0), 'high-risk');
  assert.equal(assessRisk(120, 40), 'high-risk'); // a typical cheap LED bulb
  // Above ~3 kHz the no-risk line is over 100% modulation, so frequency alone
  // earns the rating - the reason "N times under the limit" is meaningless here.
  assert.ok(riskLimits(14000).noRisk > 100);
  assert.equal(assessRisk(14000, 1.56), 'no-risk');
  // Real depth with no frequency behind it cannot be cleared - both boundaries
  // are functions of frequency. "No risk" would be the worst default here.
  assert.equal(assessRisk(0, 50), 'unknown');
  assert.equal(assessRisk(0, 0.2), 'no-risk'); // below the instrument's own floor
});

test('analyse turns a synthetic capture into the reported numbers', () => {
  // 120 Hz mains ripple as seen at the broad sampling rate.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const wave = Array.from({ length: FLICKER_SAMPLES }, (_, i) => 300 + 250 * Math.sin((2 * Math.PI * 120 * i) / fs));
  const r = analyseFlicker({ waveform: wave, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.ok(Math.abs(r.frequency - 120) < r.resolution, `got ${r.frequency} Hz, bin width ${r.resolution}`);
  assert.ok(r.modulationDepth > 80);
  assert.equal(r.risk, 'high-risk');
  assert.ok(Math.abs(r.windowMs - 25.4) < 0.5);
  assert.equal(r.magnitudes.length, FLICKER_SAMPLES / 2);
});

test('the cascade refines low readings and confirms high ones, never aliases the middle', () => {
  const at = (hz, extra = {}) => ({ frequency: hz, detected: true, modulationDepth: 5, ...extra });

  // Broad always runs first.
  assert.equal(nextPeriod([], {}), FLICKER_PERIODS.broad);

  // Low frequency: the fine pass's 6.8 Hz bins are what tell 100 from 120 Hz.
  assert.equal(nextPeriod([25], { 25: at(120) }), FLICKER_PERIODS.fine);
  assert.equal(bestResult({ 25: at(120), 146: at(118) }).frequency, 118);

  // The middle of the range is broad's home ground: NO escalation. The fine
  // pass's 3.5 kHz Nyquist cannot see 5 kHz - escalating there and preferring
  // the result reported a 13.7 kHz ripple as a confident ~270 Hz alias.
  assert.equal(nextPeriod([25], { 25: at(5000) }), null);
  assert.equal(bestResult({ 25: at(5000) }).frequency, 5000);
  assert.equal(nextPeriod([25], { 25: at(13706) }), null);
  assert.equal(bestResult({ 25: at(13706) }).frequency, 13706);

  // Top of the range: the fast pass confirms, and wins only if it stays fast.
  assert.equal(nextPeriod([25], { 25: at(18000) }), FLICKER_PERIODS.fast);
  assert.equal(bestResult({ 25: at(18000), 11: at(30000) }).frequency, 30000);
  assert.equal(bestResult({ 25: at(18000), 11: at(9000) }).frequency, 18000);

  // Nothing detected: nothing to refine.
  assert.equal(nextPeriod([25], { 25: { frequency: 0, detected: false } }), null);
  assert.equal(bestResult({}), null);

  // And a pass that found nothing can never outrank one that did: the broad
  // pass sees real flicker, a later escalation pass samples at the wrong rate
  // for it and sees nothing, and a fixed preference order used to hand that
  // empty result back as the answer.
  const found = { frequency: 5000, modulationDepth: 8, detected: true };
  const empty = { frequency: 0, modulationDepth: 0.2, detected: false };
  assert.equal(bestResult({ 25: found, 146: empty }).modulationDepth, 8);
  assert.equal(bestResult({ 25: found, 146: empty, 11: empty }).modulationDepth, 8);
  // When every pass agrees there is nothing, nothing is still the answer.
  assert.equal(bestResult({ 25: empty, 146: empty }).detected, false);
});


test('risk chart plots the reading where the risk verdict says it should', () => {
  // The chart and the badge must never disagree, so the test is: does the dot
  // land inside the band that assessRisk() names? Both boundary polylines are
  // in the markup, so the check is done against riskLimits() at the same
  // frequency, mapped through the same 0-100% -> y transform the chart uses.
  const yOf = (pct) => 226 - (Math.max(0, Math.min(100, pct)) / 100) * (226 - 14);
  const dotY = (svg) => Number(/<circle cx="[\d.]+" cy="([\d.]+)"/.exec(svg)[1]);

  // A cheap mains bulb: 120 Hz at 40% is high risk, so the dot sits ABOVE
  // (smaller y than) the low-risk boundary.
  const bad = { frequency: 120, modulationDepth: 40, resolution: 39.4 };
  assert.equal(assessRisk(bad.frequency, bad.modulationDepth), 'high-risk');
  assert.ok(dotY(riskChartSvg(bad)) < yOf(riskLimits(bad.frequency).lowRisk));

  // A well-filtered high-frequency driver: 1.58% at 13.7 kHz is no risk, so
  // the dot sits BELOW the no-risk
  // boundary - which up there is off the top of the chart entirely.
  const good = { frequency: 13706, modulationDepth: 1.58, resolution: 39.4 };
  assert.equal(assessRisk(good.frequency, good.modulationDepth), 'no-risk');
  assert.ok(riskLimits(good.frequency).noRisk > 100);
  assert.ok(dotY(riskChartSvg(good)) > yOf(riskLimits(good.frequency).noRisk));

  // Frequency is logarithmic left to right, and an empty chart has no dot.
  const xOf = (svg) => Number(/<circle cx="([\d.]+)"/.exec(svg)[1]);
  assert.ok(xOf(riskChartSvg(bad)) < xOf(riskChartSvg(good)));
  assert.ok(!riskChartSvg(null).includes('<circle'));
  assert.ok(!riskChartSvg({ frequency: 0, modulationDepth: 0 }).includes('<circle'));
});

// A deterministic pseudo-random source: Math.random() would make these tests
// flaky, and the point of the noise test is that it passes every time.
function noise(n, seed = 1) {
  const out = new Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 2000 + ((x / 0x7fffffff) - 0.5) * 12; // ~0.3% ripple on a bright DC level
  }
  return out;
}

test('pure sensor noise is reported as no flicker, not as a frequency', () => {
  // This is the sun case: a genuinely flicker-free source
  // still produces a peak bin and a few tenths of a percent modulation. The
  // detection gate is what stops that being printed as a measurement.
  const wave = noise(FLICKER_SAMPLES);
  const mag = magnitudeSpectrum(wave.map((s) => s - 2000 + 6));
  const bin = peakBin(mag);
  assert.ok(bin > 0, 'the peak finder always names a bin - that is the problem');
  assert.ok(peakSnr(mag, bin) < DETECT_SNR, 'noise must not clear the detection threshold');

  const out = analyseFlicker({ waveform: wave, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.equal(out.detected, false);
  assert.equal(out.frequency, 0, 'an undetected capture reports no frequency at all');
  assert.equal(out.kind, 'none');
  assert.equal(out.risk, 'no-risk');

  // The positive control: a real tone at the same DC level clears the same
  // gate by a wide margin, so the threshold sits between them, not near either.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const tone = Array.from({ length: FLICKER_SAMPLES }, (_, i) => 2000 + 300 * Math.sin((2 * Math.PI * 1000 * i) / fs));
  const hit = analyseFlicker({ waveform: tone, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.equal(hit.detected, true);
  assert.ok(hit.snr > 20, `expected a strong peak, got SNR ${hit.snr}`);
  assert.ok(Math.abs(hit.frequency - 1000) < hit.resolution);
});

test('deep flicker is not mistaken for too little light', () => {
  // The reported bug: a light switching fully off at ~236 Hz read "too little
  // light - no flicker detected", because the old gate used the MEAN of the
  // waveform and an off period drags the mean down in proportion to how deep
  // the flicker is. Same ON level, three duty cycles - all must be measured.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const pwm = (duty, peak) => Array.from({ length: FLICKER_SAMPLES }, (_, i) => (((i * 236) / fs) % 1 < duty ? peak : 5));

  for (const duty of [0.5, 0.3, 0.1]) {
    const out = analyseFlicker({ waveform: pwm(duty, 300), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
    assert.equal(out.lowSignal, false, `duty ${duty} has plenty of light when it is on`);
    assert.equal(out.detected, true);
    assert.equal(out.kind, 'pwm');
    assert.ok(out.modulationDepth > 95);
    assert.equal(out.risk, 'high-risk', 'near-100% depth at 236 Hz is high risk, not "no risk"');
  }

  // The gate still fires on a genuinely dim source: same duty, ON level under
  // the 50-count floor.
  const dim = analyseFlicker({ waveform: pwm(0.5, 30), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.equal(dim.lowSignal, true);
  assert.equal(dim.detected, false);
});

test('a real dim capture is not turned into a spike train by the pedestal', () => {
  // A real LM4 capture (2026-09-02): 7.3 lx, range 0, raw samples 10-32
  // counts against a range-0 DC pedestal of 29.74. Half-wave clipping at a
  // level that high leaves only the handful of samples poking over it, which
  // DRAWS a dramatic spike train and computes 99.5% depth out of what is
  // smooth sensor noise. The app then printed "No flicker detected" under that
  // picture - which reads as the detector ignoring obvious flicker, when in
  // fact the spikes were manufactured by subtracting more than the signal.
  const fx = JSON.parse(readFileSync(new URL('./fixtures/dim_noise_lm4.json', import.meta.url), 'utf8'));
  const r = analyseFlicker({ waveform: fx.waveform, range: fx.range, model: fx.model }, fx.period);

  assert.equal(r.pedestalSuspect, true, 'a pedestal level with the signal cannot be a dark offset');
  assert.equal(r.lowSignal, true);
  assert.equal(r.detected, false, 'smooth noise 10-32 counts wide is not flicker');
  assert.ok(r.modulationDepth < 90, `the clipping artefact read 99.5%, got ${r.modulationDepth.toFixed(1)}%`);
  assert.equal(r.rawMin, 10);
  assert.equal(r.rawMax, 32, 'the raw span travels with the result');

  // And the guard must not fire on genuinely deep flicker, whose median IS its
  // off level and therefore also sits below the pedestal.
  const fs2 = sampleRateFor(FLICKER_PERIODS.broad);
  const pwm = Array.from({ length: FLICKER_SAMPLES }, (_, i) => (((i * 236) / fs2) % 1 < 0.2 ? 900 : 5));
  const deep = analyseFlicker({ waveform: pwm, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.equal(deep.pedestalSuspect, false, 'real PWM climbs far above the dark offset');
  assert.equal(deep.detected, true);
  assert.equal(deep.kind, 'pwm');
});

test('a light too bright for the sensor is called out, never called flicker-free', () => {
  // Reported: above some brightness the flicker "goes flat". The sensor is
  // 12-bit, so the lit part of every cycle pins at 4095 while the dark part
  // keeps rising - measured contrast SHRINKS as the lamp gets brighter, then
  // the trace flattens entirely and the app said "no flicker". Same lamp
  // throughout: 120 Hz, ~90% real depth, moved closer.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const lamp = (peak) =>
    Array.from({ length: FLICKER_SAMPLES }, (_, i) =>
      Math.min(FULL_SCALE_COUNTS, Math.round(Math.sin((2 * Math.PI * 120 * i) / fs) > 0 ? peak : peak * 0.05)));
  const run = (peak) => analyseFlicker({ waveform: lamp(peak), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);

  // In range: measured honestly, and NOT flagged.
  const ok = run(3000);
  assert.equal(ok.saturated, false);
  assert.ok(ok.modulationDepth > 85);
  assert.equal(ok.risk, 'high-risk');

  // Clipping: depth collapses, so the reading must be flagged rather than
  // believed. It may still convict the lamp - clipping only shrinks depth.
  const clipped = run(40000);
  assert.equal(clipped.saturated, true);
  assert.ok(clipped.saturatedFraction > 0.02);
  assert.ok(clipped.modulationDepth < ok.modulationDepth, 'clipping understates depth - that is the bug');
  assert.equal(clipped.risk, 'high-risk', 'a lower bound can still damn a lamp');

  // Fully pinned: the trace is a flat line and depth is 0. This is the
  // dangerous one - it reads exactly like a flicker-free light.
  const flat = run(200000);
  assert.equal(flat.saturated, true);
  assert.equal(flat.modulationDepth, 0);
  assert.equal(flat.detected, false);
  assert.equal(flat.risk, 'unknown', 'a pinned sensor knows nothing - it must never report no-risk');

  // A genuinely flicker-free source that is merely in range is still cleared.
  const steady = analyseFlicker({ waveform: new Array(FLICKER_SAMPLES).fill(2000), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.equal(steady.saturated, false);
  assert.equal(steady.risk, 'no-risk');

  // The narrow spike train we fixed earlier must not be mistaken for clipping:
  // a couple of lit samples per cycle is a strobe, not a plateau.
  assert.ok(saturatedFraction(Array.from({ length: FLICKER_SAMPLES }, (_, i) => (i % 170 < 2 ? FULL_SCALE_COUNTS : 5))) < SATURATION_FRACTION);
});

test('a narrow pulse train is measured, not dismissed', () => {
  // The second reported capture: ~6 spikes a sample or two wide across the
  // 25 ms window, 0 lx between them. Two things used to go wrong at once - the
  // ON level was averaged over 30 samples when only ~12 were lit (so "too
  // little light"), and an impulse train has a FLAT spectrum, so no bin clears
  // the SNR gate and the frequency came back "none found" on a 100% strobe.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const spikes = (hz, peak, width) =>
    Array.from({ length: FLICKER_SAMPLES }, (_, i) => {
      const phase = (((i * hz) / fs) % 1) * (fs / hz);
      return phase < width ? 5 + peak * Math.sin((Math.PI * (phase + 0.5)) / width) : 5;
    });

  for (const width of [1, 2, 3]) {
    const out = analyseFlicker({ waveform: spikes(236, 300, width), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
    assert.equal(out.lowSignal, false, `a ${width}-sample spike at 300 counts is plenty of light`);
    assert.equal(out.detected, true);
    assert.equal(out.kind, 'pwm');
    assert.ok(Math.abs(out.frequency - 236) < 12, `expected ~236 Hz, got ${out.frequency}`);
    assert.equal(out.risk, 'high-risk');
  }
  // The single-sample case is where the spectrum gives up and pulse timing
  // carries it.
  assert.equal(analyseFlicker({ waveform: spikes(236, 300, 1), range: 2, model: 'lm4' }, FLICKER_PERIODS.broad).frequencySource, 'timing');
});

test('pulse timing refuses a ragged train rather than guessing', () => {
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  // Spacings all over the place: a drifting driver has no one frequency, and
  // saying so is the right answer.
  const wave = new Array(FLICKER_SAMPLES).fill(0);
  let at = 10;
  for (const gap of [40, 137, 61, 220, 95, 173, 48]) {
    if (at < FLICKER_SAMPLES) wave[at] = 800;
    at += gap;
  }
  assert.equal(pulseFrequency(wave, fs), null);
  // Evenly spaced, and it answers.
  const even = new Array(FLICKER_SAMPLES).fill(0);
  for (let i = 20; i < FLICKER_SAMPLES; i += 100) even[i] = 800;
  assert.ok(Math.abs(pulseFrequency(even, fs) - fs / 100) < 1);
});

test('PWM is told apart from ripple by waveform shape, not frequency', () => {
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  const at = (hz, fn) => {
    const wave = Array.from({ length: FLICKER_SAMPLES }, (_, i) => fn((2 * Math.PI * hz * i) / fs));
    return analyseFlicker({ waveform: wave, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  };

  // A 120 Hz square wave at 50% duty - the LED is switched fully off. Both the
  // off period and the harmonic richness should say PWM, even though 120 Hz is
  // also the mains-ripple frequency: shape wins over frequency.
  const pwm = at(120, (t) => (Math.sin(t) > 0 ? 3000 : 30));
  assert.equal(pwm.kind, 'pwm');
  assert.ok(pwm.zeroFraction > 0.1);

  // A 120 Hz sine that never approaches zero - an under-filtered rectifier.
  const mains = at(120, (t) => 2000 + 200 * Math.sin(t));
  assert.equal(mains.kind, 'mains-ripple');
  assert.ok(mains.zeroFraction < 0.05);

  // A fast, shallow, smooth wobble is supply ripple.
  const supply = at(13700, (t) => 2000 + 30 * Math.sin(t));
  assert.equal(supply.kind, 'ripple');

  // And the classifier itself, exercised directly at its boundaries.
  assert.equal(classifyFlicker({ detected: false, frequency: 120, zeroFrac: 0.9, harmonics: 9 }), 'none');
  assert.equal(classifyFlicker({ detected: true, frequency: 8000, zeroFrac: 0.4, harmonics: 0 }), 'pwm');
  assert.equal(classifyFlicker({ detected: true, frequency: 8000, zeroFrac: 0, harmonics: 0.5 }), 'pwm');
  assert.equal(classifyFlicker({ detected: true, frequency: 100, zeroFrac: 0, harmonics: 0 }), 'mains-ripple');
});

test('the noise floor is a median, so one big peak cannot lift it', () => {
  const flat = new Array(64).fill(2);
  assert.equal(noiseFloor(flat), 2);
  const withPeak = flat.slice();
  withPeak[7] = 500;
  assert.equal(noiseFloor(withPeak), 2, 'a median ignores the outlier a mean would chase');
  assert.equal(peakSnr(withPeak, 7), 250);
  assert.equal(zeroFraction([100, 100, 1, 1]), 0.5);
  assert.equal(harmonicRatio([0, 0], 1), 0);
});

test('real depth is never called flicker-free just because the peak is smeared', () => {
  // Requiring a clean spectral peak AND depth meant a
  // 5-10% source with messy, drifting flicker came back "flicker-free". Depth
  // alone is enough - PAR-1789 is written in modulation depth, not spectral purity.
  const fs = sampleRateFor(FLICKER_PERIODS.broad);
  let x = 99;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  // Modulation that wanders across frequencies rather than sitting on one.
  const wave = Array.from({ length: FLICKER_SAMPLES }, (_, i) => {
    const drift = 300 + 900 * (i / FLICKER_SAMPLES);
    return 2000 * (1 + 0.08 * Math.sin((2 * Math.PI * drift * i) / fs) + 0.02 * rnd());
  });
  const out = analyseFlicker({ waveform: wave, range: 2, model: 'lm4' }, FLICKER_PERIODS.broad);
  assert.ok(out.modulationDepth >= DETECT_DEPTH_PCT, `depth was ${out.modulationDepth}`);
  assert.equal(out.detected, true, 'depth alone must be enough to count as flicker');
  // And it still lands on the chart rather than vanishing from it.
  assert.ok(riskChartSvg(out).includes('<circle'), 'a detected capture must be plotted');
});
