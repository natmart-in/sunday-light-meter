// Sunday Light Meter - page controller.
//
// Mounts into a root element, talks to an Opple Light Master over Web
// Bluetooth (see meter.js) and renders the live readout plus the "check
// your Sunday light" calibration workflow.

import { OppleMeter, bluetoothSupport, processMeasurement } from './meter.js';
import { cctToCss, wavelengthToCss } from './colour.js';
import { lm4Process } from './lm4.js';

const STORAGE = { checks: 'slm.checks.v1', gen: 'slm.gen.v1', ambient: 'slm.ambient.v1' };
const CAPTURE_SAMPLES = 8;
const LIVE_SMOOTHING = 3;
const TOLERANCE_GOOD = 60;
const TOLERANCE_OK = 150;
const MIN_CHECK_LUX = 30;

// Physical limits of the two LED dies fitted to Sunday lights. Commanded
// colour temperatures beyond the dies are clamped by the light, so the
// expected reading is the clamped value, not the number on the slider.
const LED_GENERATIONS = {
  unknown: { label: "Don't know", warm: null, cool: null, hint: 'Measure your light at its warmest and coolest settings: those two readings are its die limits.' },
  genA: { label: 'Earlier lights (built up to Feb 2025)', warm: 2720, cool: 6900, hint: 'Warm die ~2720 K, cool die ~6900 K.' },
  genB: { label: 'Later lights (built from Apr 2025)', warm: 2820, cool: 7930, hint: 'Warm die ~2820 K, cool die ~7930 K.' },
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // private mode etc. - the page still works without persistence
    }
  },
};

const fmt = {
  int: (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : Math.round(v).toLocaleString('en-GB')),
  fixed: (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d)),
  signed: (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`),
  lux: (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(1)),
  time: (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// Simulated meter for browsers without Web Bluetooth / demos
// ---------------------------------------------------------------------------

const DEMO_K = [1.010141, 1.009422, 0.928753, 1.037585, 0.968898, 1.181077, 0.961893, 1.059147, 1.0];
const DEMO_RAW = [654, 819, 855, 1152, 1330, 1719, 2595, 3715, 14571];
const LM4_WL = [415, 445, 480, 515, 555, 590, 630, 680, 555];

const demoTilt = (t) => DEMO_RAW.map((v, i) => v * (LM4_WL[i] / 555) ** t);

/** Spectral tilt exponent that makes the LM4 pipeline read `targetK` from the demo spectrum. */
function demoTiltFor(targetK) {
  const cctOf = (t) => lm4Process(demoTilt(t).map((v, i) => v * DEMO_K[i])).cct;
  // CCT falls monotonically with t over this range (~8000 K down to ~1800 K);
  // stronger blue tilts push the matrix into negative XYZ and are not usable.
  let lo = -1.8;
  let hi = 8;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (cctOf(mid) < targetK) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

class SimulatedMeter extends EventTarget {
  constructor() {
    super();
    this.model = 'lm4';
    this.calibration = { model: 'lm4', kSensor: DEMO_K };
    this.timer = null;
    this.t0 = Date.now();
    this.targetK = 3000;
    this.level = 0.35;
    this.tilt = demoTiltFor(3000);
  }

  get connected() {
    return !!this.timer;
  }

  modelName() {
    return 'Simulated Light Master 4';
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect() {
    this.emit('status', { state: 'connected', message: 'Simulated meter connected - readings are synthetic' });
    return { name: 'Demo', model: 'lm4', modelName: this.modelName(), kSensor: DEMO_K };
  }

  setScene(k, level) {
    if (k !== this.targetK) this.tilt = demoTiltFor(k);
    this.targetK = k;
    this.level = level;
  }

  startPolling(interval = 500) {
    this.stopPolling();
    const tick = () => {
      const t = (Date.now() - this.t0) / 1000;
      // Slow colour drift (a few kelvin) plus per-sample noise, like a real light.
      const scale = this.level * (1 + 0.01 * Math.sin(t / 3));
      const raw = demoTilt(this.tilt + 0.01 * Math.sin(t / 7)).map((v) => Math.max(0, Math.round(v * scale * (1 + (Math.random() - 0.5) * 0.01))));
      this.emit('reading', processMeasurement({ model: 'lm4', raw, batteryRaw: 3300, temperature: null }, this.calibration));
      this.timer = setTimeout(tick, interval);
    };
    this.timer = setTimeout(tick, 0);
  }

  stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  disconnect() {
    this.stopPolling();
    this.emit('status', { state: 'disconnected', message: 'Disconnected' });
    this.emit('disconnected', {});
  }
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function template() {
  const genOptions = Object.entries(LED_GENERATIONS)
    .map(([k, g]) => `<option value="${k}">${esc(g.label)}</option>`)
    .join('');
  return `
<div class="slm__notice" data-el="support" hidden></div>

<section class="slm__connect" aria-label="Meter connection">
  <div class="slm__connect-left">
    <button class="slm__btn slm__btn--primary" type="button" data-el="connect">Connect light meter</button>
    <button class="slm__btn slm__btn--ghost" type="button" data-el="disconnect" hidden>Disconnect</button>
    <button class="slm__btn slm__btn--link" type="button" data-el="demo">Try a simulated meter</button>
  </div>
  <div class="slm__status" data-el="status">
    <span class="slm__dot" data-el="dot"></span>
    <span data-el="status-text">Not connected</span>
    <span class="slm__chip" data-el="model" hidden></span>
    <span class="slm__chip" data-el="battery" hidden></span>
    <span class="slm__chip slm__chip--warn" data-el="uncal" hidden title="The meter did not return its calibration factors - readings are raw">uncalibrated</span>
  </div>
</section>

<section class="slm__live" aria-label="Live reading">
  <div class="slm__sun-wrap">
    <div class="slm__sun" data-el="sun"><span class="slm__sun-core"></span></div>
  </div>
  <div class="slm__hero">
    <div class="slm__hero-value"><span data-el="cct">––––</span><span class="slm__hero-unit">K</span></div>
    <div class="slm__hero-label">Colour temperature <span data-el="mode" class="slm__mode"></span></div>
    <div class="slm__hero-sub"><b data-el="lux">–</b> lux &nbsp;·&nbsp; Duv <b data-el="duv">–</b> &nbsp;·&nbsp; tint <b data-el="tint">–</b></div>
  </div>
  <dl class="slm__metrics">
    <div><dt>CRI Ra</dt><dd data-el="ra">–</dd></div>
    <div><dt>R9 <small>deep red</small></dt><dd data-el="r9">–</dd></div>
    <div><dt>Melanopic <small>EML</small></dt><dd data-el="eml">–</dd></div>
    <div><dt>x, y</dt><dd data-el="xy" class="slm__small">–</dd></div>
    <div data-el="cs-wrap"><dt>Circadian <small>CS</small></dt><dd data-el="cs">–</dd></div>
    <div><dt>R1–R14</dt><dd data-el="rlist" class="slm__rlist">–</dd></div>
  </dl>
  <div class="slm__spectrum" data-el="spectrum" aria-label="Sensor bands"></div>
</section>

<section class="slm__check" aria-label="Check your Sunday light">
  <header class="slm__check-head">
    <h2>Check your Sunday light</h2>
    <p>Set a colour temperature in the Sunday app, point the meter at the light from where you sit, and capture. The chart shows how close the light lands to what you asked for.</p>
  </header>
  <div class="slm__check-grid">
    <form class="slm__form" data-el="form">
      <label class="slm__field">
        <span>Colour temperature set in the app</span>
        <div class="slm__range">
          <input type="range" min="2000" max="8000" step="50" value="3000" data-el="set-cct-range">
          <output data-el="set-cct-out">3000 K</output>
        </div>
      </label>
      <label class="slm__field">
        <span>Brightness set in the app</span>
        <div class="slm__range">
          <input type="range" min="1" max="100" step="1" value="100" data-el="set-b-range">
          <output data-el="set-b-out">100%</output>
        </div>
      </label>
      <label class="slm__field">
        <span>Which light do you have?</span>
        <select data-el="gen">${genOptions}</select>
        <small data-el="gen-hint"></small>
      </label>
      <div class="slm__actions">
        <button class="slm__btn slm__btn--primary" type="submit" data-el="capture" disabled>Capture reading</button>
        <button class="slm__btn slm__btn--ghost" type="button" data-el="ambient" disabled title="With the light off, record the room's ambient light so dim readings are flagged">Record ambient</button>
      </div>
      <p class="slm__ambient" data-el="ambient-text"></p>
      <ul class="slm__tips">
        <li>Dark room, curtains closed. Daylight skews the reading cool.</li>
        <li>Hold the meter where the light lands - your desk or sofa - with the sensor facing the light.</li>
        <li>Give the light 30 seconds to settle after changing the setting.</li>
        <li>Within ±60 K is spot on; ±150 K is within normal tolerance for a two-die mix.</li>
      </ul>
    </form>
    <div class="slm__chart-wrap">
      <svg data-el="chart" viewBox="0 0 560 400" role="img" aria-label="Measured colour temperature versus the setting"></svg>
      <div class="slm__legend">
        <span><i class="slm__legend-line"></i> perfect match</span>
        <span><i class="slm__legend-band"></i> ±150 K</span>
        <span><i class="slm__legend-die"></i> die limits</span>
        <span><i class="slm__legend-dot"></i> your readings</span>
      </div>
    </div>
  </div>
  <div class="slm__results" data-el="results" hidden>
    <div class="slm__results-bar">
      <span data-el="summary"></span>
      <span class="slm__results-actions">
        <button class="slm__btn slm__btn--ghost slm__btn--sm" type="button" data-el="export">Download CSV</button>
        <button class="slm__btn slm__btn--ghost slm__btn--sm" type="button" data-el="clear">Clear</button>
      </span>
    </div>
    <div class="slm__table-wrap">
      <table class="slm__table">
        <thead><tr><th>Set</th><th>Bright.</th><th>Measured</th><th>Δ</th><th>Verdict</th><th>Lux</th><th>Duv</th><th>Ra</th><th>R9</th><th>Time</th><th></th></tr></thead>
        <tbody data-el="rows"></tbody>
      </table>
    </div>
  </div>
</section>

<footer class="slm__foot">
  <p>Works with the Opple Light Master 3 and 4 over Web Bluetooth in Chrome, Edge and other Chromium browsers (desktop and Android). On iPhone and iPad use the <a href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055" rel="noopener" target="_blank">Bluefy</a> browser. Readings use each meter's own factory calibration and the same maths as the Opple app.</p>
</footer>
<div class="slm__toast" data-el="toast" hidden></div>
`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function mount(root) {
  root.classList.add('slm');
  root.innerHTML = template();
  const el = (name) => root.querySelector(`[data-el="${name}"]`);
  const els = {};
  root.querySelectorAll('[data-el]').forEach((n) => {
    els[n.dataset.el] = n;
  });

  const state = {
    meter: null,
    simulated: false,
    live: null,
    rawHistory: [],
    capture: null, // { samples: [], resolve }
    checks: store.get(STORAGE.checks, []),
    gen: store.get(STORAGE.gen, 'unknown'),
    ambient: store.get(STORAGE.ambient, null),
  };

  let toastTimer = null;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('slm__toast--error', isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 4200);
  }

  // -- support banner -------------------------------------------------------
  const support = bluetoothSupport();
  if (!support.ok) {
    els.support.hidden = false;
    els.support.innerHTML =
      support.reason === 'insecure'
        ? 'Web Bluetooth only runs on secure (https) pages.'
        : 'This browser cannot talk to Bluetooth devices. Open this page in <b>Chrome</b> or <b>Edge</b> on a computer or Android phone, or in the <b>Bluefy</b> browser on iPhone/iPad. You can still try the simulated meter below.';
    els.connect.disabled = true;
  }

  // -- connection -----------------------------------------------------------
  function setStatus(stateName, message) {
    els['status-text'].textContent = message;
    els.dot.className = `slm__dot slm__dot--${stateName}`;
    const connected = stateName === 'connected';
    els.connect.hidden = connected;
    els.disconnect.hidden = !connected;
    els.demo.hidden = connected;
    els.capture.disabled = !connected;
    els.ambient.disabled = !connected;
    if (!connected) {
      els.model.hidden = true;
      els.battery.hidden = true;
      els.uncal.hidden = true;
    }
  }

  function attach(meter, simulated) {
    state.meter = meter;
    state.simulated = simulated;
    state.rawHistory = [];
    meter.addEventListener('status', (e) => {
      setStatus(e.detail.state, e.detail.message);
      if (e.detail.state === 'connected') {
        els.model.textContent = meter.modelName();
        els.model.hidden = false;
        els.uncal.hidden = !!(meter.calibration && meter.calibration.kSensor);
      }
      if (e.detail.state === 'warning') toast(e.detail.message, true);
    });
    meter.addEventListener('reading', (e) => onReading(e.detail));
    meter.addEventListener('disconnected', () => {
      state.meter = null;
      state.live = null;
      renderLive(null);
    });
  }

  async function connectReal() {
    const meter = new OppleMeter();
    attach(meter, false);
    els.connect.disabled = true;
    try {
      await meter.connect();
      meter.startPolling(500);
      toast(`${meter.modelName()} connected${meter.calibration ? ' - calibration loaded' : ''}`);
    } catch (err) {
      state.meter = null;
      const cancelled = err && (err.name === 'NotFoundError' || /cancel/i.test(err.message));
      setStatus('disconnected', cancelled ? 'No meter chosen' : 'Connection failed');
      if (!cancelled) toast(err.message || String(err), true);
    } finally {
      els.connect.disabled = !support.ok;
    }
  }

  function connectDemo() {
    const meter = new SimulatedMeter();
    attach(meter, true);
    meter.connect().then(() => {
      meter.setScene(Number(els['set-cct-range'].value), 0.35);
      meter.startPolling(500);
      els.model.textContent = 'Simulated LM4';
      els.model.hidden = false;
    });
  }

  els.connect.addEventListener('click', connectReal);
  els.demo.addEventListener('click', connectDemo);
  els.disconnect.addEventListener('click', () => {
    if (state.meter) state.meter.disconnect();
  });

  // -- readings -------------------------------------------------------------
  function averageRaw(samples) {
    const n = samples[0].length;
    const out = new Array(n).fill(0);
    for (const s of samples) for (let i = 0; i < n; i++) out[i] += s[i] / samples.length;
    return out;
  }

  function onReading(reading) {
    const meter = state.meter;
    if (!meter) return;
    const cal = meter.calibration;
    state.rawHistory.push(reading.raw);
    if (state.rawHistory.length > LIVE_SMOOTHING) state.rawHistory.shift();
    const smoothed = state.rawHistory.length > 1 ? processMeasurement({ model: reading.model, raw: averageRaw(state.rawHistory), batteryRaw: 0 }, cal) : reading;
    state.live = { ...smoothed, battery: reading.battery, temperature: reading.temperature };
    renderLive(state.live);

    if (state.capture) {
      state.capture.samples.push(reading.raw);
      const n = state.capture.samples.length;
      els.capture.textContent = `Capturing… ${n}/${CAPTURE_SAMPLES}`;
      if (n >= CAPTURE_SAMPLES) {
        const avg = processMeasurement({ model: reading.model, raw: averageRaw(state.capture.samples), batteryRaw: 0 }, cal);
        const done = state.capture;
        state.capture = null;
        els.capture.textContent = 'Capture reading';
        els.capture.disabled = false;
        els.ambient.disabled = false;
        done.resolve(avg);
      }
    }
  }

  function captureAverage() {
    if (!state.meter || !state.meter.connected) return Promise.reject(new Error('Connect a meter first'));
    if (state.capture) return Promise.reject(new Error('Already capturing'));
    els.capture.disabled = true;
    els.ambient.disabled = true;
    return new Promise((resolve) => {
      state.capture = { samples: [], resolve };
    });
  }

  // -- live render ----------------------------------------------------------
  function renderLive(r) {
    const lit = r && r.lux > 0.5 && Number.isFinite(r.cct);
    els.cct.textContent = lit ? fmt.int(r.cct) : '––––';
    els.lux.textContent = r ? fmt.lux(r.lux) : '–';
    els.duv.textContent = lit ? fmt.signed(r.duv, 4) : '–';
    els.tint.textContent = lit ? fmt.signed(r.tint, 0) : '–';
    els.ra.textContent = lit && r.Ra !== null ? fmt.fixed(r.Ra, 1) : '–';
    els.r9.textContent = lit && r.R ? fmt.fixed(r.R[8], 1) : '–';
    els.eml.textContent = lit && r.eml !== null ? fmt.int(r.eml) : '–';
    els.xy.textContent = lit ? `${r.x.toFixed(4)}, ${r.y.toFixed(4)}` : '–';
    els['cs-wrap'].hidden = !(r && r.model === 'lm4');
    els.cs.textContent = lit && r.cs !== null ? fmt.fixed(r.cs, 3) : '–';
    els.mode.textContent = r && r.modeName ? `· ${r.modeName}` : '';
    els.rlist.textContent = lit && r.R ? r.R.map((v) => Math.round(v)).join(' ') : '–';
    els.ra.title = r && r.criSource === 'spline' ? 'Estimated from a spline through the sensor bands' : r && r.criSource === 'opple-model' ? "Opple's LM4 model" : '';

    if (r && r.battery && r.battery.percent !== null) {
      els.battery.textContent = `battery ${Math.round(r.battery.percent)}%`;
      els.battery.hidden = false;
    }

    const sun = els.sun;
    if (lit) {
      const colour = cctToCss(r.cct);
      const glow = Math.min(1, Math.log10(1 + r.lux) / 3.5);
      sun.style.setProperty('--sun', colour);
      sun.style.setProperty('--glow', glow.toFixed(3));
      sun.classList.add('slm__sun--lit');
    } else {
      sun.classList.remove('slm__sun--lit');
    }
    renderSpectrum(r);
  }

  function renderSpectrum(r) {
    const host = els.spectrum;
    if (!r || !r.bands) {
      host.innerHTML = '';
      return;
    }
    const max = Math.max(1e-9, ...r.bands);
    host.innerHTML = r.bandWavelengths
      .map((wl, i) => {
        const h = Math.max(2, (100 * r.bands[i]) / max);
        return `<div class="slm__band" title="${wl} nm"><div class="slm__band-bar" style="height:${h.toFixed(1)}%;background:${wavelengthToCss(wl)}"></div><span>${wl}</span></div>`;
      })
      .join('');
  }

  // -- check workflow -------------------------------------------------------
  const genSelect = els.gen;
  genSelect.value = state.gen;
  function renderGenHint() {
    els['gen-hint'].textContent = LED_GENERATIONS[state.gen].hint;
  }
  renderGenHint();
  genSelect.addEventListener('change', () => {
    state.gen = genSelect.value;
    store.set(STORAGE.gen, state.gen);
    renderGenHint();
    renderChecks();
  });

  const syncRange = (range, out, unit) => {
    const update = () => {
      out.textContent = `${range.value}${unit}`;
      if (state.simulated && state.meter && range === els['set-cct-range']) state.meter.setScene(Number(range.value), 0.35);
    };
    range.addEventListener('input', update);
    update();
  };
  syncRange(els['set-cct-range'], els['set-cct-out'], ' K');
  syncRange(els['set-b-range'], els['set-b-out'], '%');

  function expectedFor(setK, genKey) {
    const g = LED_GENERATIONS[genKey] || LED_GENERATIONS.unknown;
    if (g.warm === null) return setK;
    return Math.min(g.cool, Math.max(g.warm, setK));
  }

  function verdictFor(check) {
    const expected = expectedFor(check.setCct, state.gen);
    const delta = check.cct - expected;
    if (check.lux < MIN_CHECK_LUX) return { key: 'dim', label: 'Too dim', delta, expected };
    if (state.ambient && check.lux < state.ambient.lux * 20) return { key: 'ambient', label: 'Ambient light', delta, expected };
    const a = Math.abs(delta);
    if (a <= TOLERANCE_GOOD) return { key: 'good', label: 'Spot on', delta, expected };
    if (a <= TOLERANCE_OK) return { key: 'ok', label: 'Close', delta, expected };
    return { key: 'off', label: delta > 0 ? 'Too cool' : 'Too warm', delta, expected };
  }

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Record the settings at the moment of the click, not when the average lands.
    const setCct = Number(els['set-cct-range'].value);
    const brightness = Number(els['set-b-range'].value);
    try {
      const r = await captureAverage();
      if (!(r.lux > 0) || !Number.isFinite(r.cct)) {
        toast('No light reaching the sensor', true);
        return;
      }
      const check = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        setCct,
        brightness,
        gen: state.gen,
        model: r.model,
        simulated: state.simulated,
        cct: r.cct,
        lux: r.lux,
        duv: r.duv,
        tint: r.tint,
        x: r.x,
        y: r.y,
        Ra: r.Ra,
        R9: r.R ? r.R[8] : null,
        eml: r.eml,
      };
      state.checks.push(check);
      store.set(STORAGE.checks, state.checks);
      renderChecks();
      const v = verdictFor(check);
      toast(`${fmt.int(check.cct)} K measured - ${v.label} (${fmt.signed(v.delta)} K)`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  els.ambient.addEventListener('click', async () => {
    try {
      const r = await captureAverage();
      state.ambient = { lux: r.lux, cct: Number.isFinite(r.cct) ? r.cct : null, ts: Date.now() };
      store.set(STORAGE.ambient, state.ambient);
      renderAmbient();
      renderChecks();
      toast(`Ambient recorded: ${fmt.lux(r.lux)} lux`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  function renderAmbient() {
    const a = state.ambient;
    els['ambient-text'].innerHTML = a ? `Ambient baseline <b>${fmt.lux(a.lux)} lux</b>${a.cct ? ` at ${fmt.int(a.cct)} K` : ''}. Readings under 20× this are flagged. <button type="button" class="slm__btn slm__btn--link" data-el="ambient-clear">Forget</button>` : '';
    const clearBtn = els['ambient-text'].querySelector('[data-el="ambient-clear"]');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        state.ambient = null;
        store.set(STORAGE.ambient, null);
        renderAmbient();
        renderChecks();
      });
    }
  }
  renderAmbient();

  els.clear.addEventListener('click', () => {
    state.checks = [];
    store.set(STORAGE.checks, state.checks);
    renderChecks();
  });

  els.export.addEventListener('click', () => {
    const cols = ['time', 'set_cct_k', 'brightness_pct', 'light_generation', 'expected_cct_k', 'measured_cct_k', 'delta_k', 'verdict', 'lux', 'duv', 'tint', 'x', 'y', 'cri_ra', 'r9', 'eml', 'meter', 'simulated'];
    const lines = [cols.join(',')];
    for (const c of state.checks) {
      const v = verdictFor(c);
      lines.push(
        [
          new Date(c.ts).toISOString(),
          c.setCct,
          c.brightness,
          state.gen,
          v.expected,
          c.cct.toFixed(0),
          v.delta.toFixed(0),
          v.label,
          c.lux.toFixed(1),
          c.duv.toFixed(4),
          Number.isFinite(c.tint) ? c.tint.toFixed(1) : '',
          c.x.toFixed(4),
          c.y.toFixed(4),
          c.Ra === null ? '' : c.Ra.toFixed(1),
          c.R9 === null ? '' : c.R9.toFixed(1),
          c.eml === null ? '' : c.eml.toFixed(0),
          c.model,
          c.simulated ? 'yes' : 'no',
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sunday-light-check-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  });

  function renderChecks() {
    const rows = state.checks;
    els.results.hidden = rows.length === 0;
    els.rows.innerHTML = rows
      .slice()
      .reverse()
      .map((c) => {
        const v = verdictFor(c);
        return `<tr>
          <td>${c.setCct} K</td>
          <td>${c.brightness}%</td>
          <td><b>${fmt.int(c.cct)} K</b></td>
          <td class="slm__delta slm__delta--${v.key}">${fmt.signed(v.delta)}</td>
          <td><span class="slm__verdict slm__verdict--${v.key}">${esc(v.label)}</span></td>
          <td>${fmt.lux(c.lux)}</td>
          <td>${fmt.signed(c.duv, 4)}</td>
          <td>${fmt.fixed(c.Ra, 1)}</td>
          <td>${fmt.fixed(c.R9, 1)}</td>
          <td class="slm__muted">${fmt.time(c.ts)}${c.simulated ? ' <small>sim</small>' : ''}</td>
          <td><button type="button" class="slm__x" data-remove="${c.id}" aria-label="Remove">×</button></td>
        </tr>`;
      })
      .join('');
    els.rows.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => {
        state.checks = state.checks.filter((c) => c.id !== b.dataset.remove);
        store.set(STORAGE.checks, state.checks);
        renderChecks();
      });
    });
    const scored = rows.map(verdictFor).filter((v) => v.key !== 'dim' && v.key !== 'ambient');
    if (scored.length) {
      const mean = scored.reduce((a, v) => a + Math.abs(v.delta), 0) / scored.length;
      const worst = Math.max(...scored.map((v) => Math.abs(v.delta)));
      els.summary.innerHTML = `<b>${rows.length}</b> reading${rows.length === 1 ? '' : 's'} · mean error <b>${Math.round(mean)} K</b> · worst <b>${Math.round(worst)} K</b>`;
    } else {
      els.summary.textContent = `${rows.length} reading${rows.length === 1 ? '' : 's'}`;
    }
    renderChart();
  }

  // -- chart ----------------------------------------------------------------
  function renderChart() {
    const svg = els.chart;
    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      return n;
    };
    svg.innerHTML = '';
    const W = 560;
    const H = 400;
    const ML = 62;
    const MR = 18;
    const MT = 18;
    const MB = 48;
    const iw = W - ML - MR;
    const ih = H - MT - MB;
    const gen = LED_GENERATIONS[state.gen];
    const pts = state.checks;
    let lo = 2000;
    let hi = 8000;
    if (pts.length) {
      lo = Math.min(lo, ...pts.map((p) => Math.min(p.setCct, p.cct)));
      hi = Math.max(hi, ...pts.map((p) => Math.max(p.setCct, p.cct)));
      lo = Math.floor(lo / 500) * 500;
      hi = Math.ceil(hi / 500) * 500;
    }
    const x = (v) => ML + (iw * (v - lo)) / (hi - lo);
    const y = (v) => MT + ih * (1 - (v - lo) / (hi - lo));

    // grid
    for (let v = lo; v <= hi; v += 1000) {
      svg.appendChild(mk('line', { x1: x(v), y1: MT, x2: x(v), y2: MT + ih, class: 'slm__grid' }));
      svg.appendChild(mk('line', { x1: ML, y1: y(v), x2: ML + iw, y2: y(v), class: 'slm__grid' }));
      svg.appendChild(mk('text', { x: x(v), y: MT + ih + 18, class: 'slm__tick', 'text-anchor': 'middle' }, `${v / 1000}k`));
      svg.appendChild(mk('text', { x: ML - 8, y: y(v) + 4, class: 'slm__tick', 'text-anchor': 'end' }, `${v / 1000}k`));
    }
    svg.appendChild(mk('text', { x: ML + iw / 2, y: H - 8, class: 'slm__axis', 'text-anchor': 'middle' }, 'SET IN THE APP (K)'));
    svg.appendChild(mk('text', { x: 16, y: MT + ih / 2, class: 'slm__axis', 'text-anchor': 'middle', transform: `rotate(-90 16 ${MT + ih / 2})` }, 'MEASURED (K)'));

    // tolerance band + ideal line (clamped to die limits when known)
    const ideal = (v) => expectedFor(v, state.gen);
    const steps = [];
    for (let v = lo; v <= hi; v += 25) steps.push(v);
    const band = `${steps.map((v, i) => `${i ? 'L' : 'M'}${x(v).toFixed(1)} ${y(ideal(v) + TOLERANCE_OK).toFixed(1)}`).join(' ')} ${steps
      .slice()
      .reverse()
      .map((v) => `L${x(v).toFixed(1)} ${y(ideal(v) - TOLERANCE_OK).toFixed(1)}`)
      .join(' ')} Z`;
    svg.appendChild(mk('path', { d: band, class: 'slm__band-area' }));
    svg.appendChild(mk('path', { d: steps.map((v, i) => `${i ? 'L' : 'M'}${x(v).toFixed(1)} ${y(ideal(v)).toFixed(1)}`).join(' '), class: 'slm__ideal' }));
    if (gen.warm !== null) {
      for (const k of [gen.warm, gen.cool]) {
        svg.appendChild(mk('line', { x1: ML, y1: y(k), x2: ML + iw, y2: y(k), class: 'slm__die' }));
        svg.appendChild(mk('text', { x: ML + iw - 4, y: y(k) - 4, class: 'slm__tick', 'text-anchor': 'end' }, `${k} K die`));
      }
    }

    // points
    for (const p of pts) {
      const v = verdictFor(p);
      const g = mk('g', { class: `slm__pt slm__pt--${v.key}` });
      g.appendChild(mk('circle', { cx: x(p.setCct), cy: y(p.cct), r: 6 }));
      g.appendChild(mk('title', {}, `${p.setCct} K set at ${p.brightness}% → ${Math.round(p.cct)} K (${fmt.signed(v.delta)} K) · ${fmt.lux(p.lux)} lux · Duv ${fmt.signed(p.duv, 4)} · ${v.label}`));
      svg.appendChild(g);
    }
    if (!pts.length) svg.appendChild(mk('text', { x: ML + iw / 2, y: MT + ih / 2, class: 'slm__empty', 'text-anchor': 'middle' }, 'Captured readings appear here'));
  }

  renderLive(null);
  renderChecks();
  setStatus('disconnected', 'Not connected');

  if (new URLSearchParams(location.search).get('demo') === '1') connectDemo();
  return { state };
}

if (typeof window !== 'undefined') {
  window.SundayLightMeter = { mount };
  const auto = document.getElementById('sunday-light-meter');
  if (auto) mount(auto);
}
