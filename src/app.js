// Light Meter - page controller.
//
// Mounts into a root element, talks to an Opple Light Master over Web
// Bluetooth (see meter.js) and renders the live readout, a reading log
// with CSV export, and a diagnostics panel.

import { OppleMeter, bluetoothSupport, processMeasurement } from './meter.js';
import { cctToCss, wavelengthToCss } from './colour.js';
import { lm4Process } from './lm4.js';

const STORAGE = { log: 'slm.readings.v1' };
const CAPTURE_SAMPLES = 8;
const LIVE_SMOOTHING = 3;
const DIAG_LINES = 500;

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
  clock: (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ts % 1000).padStart(3, '0'),
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
    this.sceneTimer = null;
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
    this.emit('log', { ts: Date.now(), level: 'info', message: 'simulated meter: no Bluetooth involved' });
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
    // Wander through a few "lamps" so the demo has something to log.
    const scenes = [
      [3000, 0.35],
      [2700, 0.2],
      [4000, 0.6],
      [6500, 0.9],
      [5000, 0.5],
    ];
    let i = 0;
    this.sceneTimer = setInterval(() => {
      i = (i + 1) % scenes.length;
      this.setScene(scenes[i][0], scenes[i][1]);
    }, 20000);
    const tick = () => {
      const t = (Date.now() - this.t0) / 1000;
      const scale = this.level * (1 + 0.01 * Math.sin(t / 3));
      const raw = demoTilt(this.tilt + 0.01 * Math.sin(t / 7)).map((v) => Math.max(0, Math.round(v * scale * (1 + (Math.random() - 0.5) * 0.01))));
      this.emit('reading', processMeasurement({ model: 'lm4', raw, batteryRaw: 3300, temperature: null }, this.calibration));
      this.timer = setTimeout(tick, interval);
    };
    this.timer = setTimeout(tick, 0);
  }

  stopPolling() {
    if (this.timer) clearTimeout(this.timer);
    if (this.sceneTimer) clearInterval(this.sceneTimer);
    this.timer = null;
    this.sceneTimer = null;
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

<section class="slm__log" aria-label="Reading log">
  <form class="slm__log-form" data-el="form">
    <label class="slm__field slm__field--grow">
      <span>Label</span>
      <input type="text" data-el="label" placeholder="e.g. desk lamp at 3000 K" maxlength="80" autocomplete="off">
    </label>
    <button class="slm__btn slm__btn--primary" type="submit" data-el="capture" disabled>Log reading</button>
    <span class="slm__hint">Averages ${CAPTURE_SAMPLES} samples, about ${Math.round(CAPTURE_SAMPLES / 2)} seconds.</span>
  </form>
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
        <thead><tr><th>Label</th><th>CCT</th><th>Lux</th><th>Duv</th><th>Tint</th><th>Ra</th><th>R9</th><th>EML</th><th>x, y</th><th>Time</th><th></th></tr></thead>
        <tbody data-el="rows"></tbody>
      </table>
    </div>
  </div>
</section>

<footer class="slm__foot">
  <p>Works with the Opple Light Master 3 and 4 over Web Bluetooth in Chrome, Edge and other Chromium browsers (desktop and Android). On iPhone and iPad use the <a href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055" rel="noopener" target="_blank">Bluefy</a> browser. Readings use each meter's own factory calibration and the same maths as the Opple app; nothing leaves your browser. <button type="button" class="slm__btn slm__btn--link" data-el="diag-toggle">Diagnostics</button></p>
</footer>

<section class="slm__diag" data-el="diag" hidden aria-label="Diagnostics">
  <div class="slm__diag-bar">
    <b>Diagnostics</b>
    <span class="slm__diag-actions">
      <label class="slm__check"><input type="checkbox" data-el="diag-verbose"> raw frames</label>
      <button class="slm__btn slm__btn--ghost slm__btn--sm" type="button" data-el="diag-copy">Copy log</button>
      <button class="slm__btn slm__btn--ghost slm__btn--sm" type="button" data-el="diag-clear">Clear</button>
    </span>
  </div>
  <pre class="slm__diag-log" data-el="diag-log"></pre>
</section>
<div class="slm__toast" data-el="toast" hidden></div>
`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function mount(root) {
  root.classList.add('slm');
  root.innerHTML = template();
  const els = {};
  root.querySelectorAll('[data-el]').forEach((n) => {
    els[n.dataset.el] = n;
  });
  const params = new URLSearchParams(location.search);

  const state = {
    meter: null,
    simulated: false,
    live: null,
    rawHistory: [],
    capture: null, // { samples: [], resolve, reject }
    readings: store.get(STORAGE.log, []),
    diag: [],
    verbose: params.get('debug') === '2',
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

  // -- diagnostics ----------------------------------------------------------
  function diag(message, level = 'info', ts = Date.now()) {
    state.diag.push({ ts, level, message });
    if (state.diag.length > DIAG_LINES) state.diag.shift();
    if (!els.diag.hidden) renderDiag(true);
    if (level === 'error' || level === 'warn') console.warn(`[light-meter] ${message}`);
    else if (level !== 'debug') console.info(`[light-meter] ${message}`);
  }

  function diagText() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const head = `Light meter diagnostics · ${new Date().toISOString()} · ${ua}`;
    return [head, ...state.diag.map((l) => `${fmt.clock(l.ts)} ${l.level.padEnd(5)} ${l.message}`)].join('\n');
  }

  function renderDiag(append = false) {
    const pre = els['diag-log'];
    pre.textContent = state.diag.map((l) => `${fmt.clock(l.ts)} ${l.level.padEnd(5)} ${l.message}`).join('\n') || '(nothing yet)';
    if (append) pre.scrollTop = pre.scrollHeight;
  }

  els['diag-toggle'].addEventListener('click', () => {
    els.diag.hidden = !els.diag.hidden;
    if (!els.diag.hidden) renderDiag(true);
  });
  els['diag-verbose'].checked = state.verbose;
  els['diag-verbose'].addEventListener('change', () => {
    state.verbose = els['diag-verbose'].checked;
    if (state.meter && 'verbose' in state.meter) state.meter.verbose = state.verbose;
  });
  els['diag-clear'].addEventListener('click', () => {
    state.diag = [];
    renderDiag();
  });
  els['diag-copy'].addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagText());
      toast('Diagnostics copied');
    } catch (_) {
      // Fallback: select the text so it can be copied manually.
      const range = document.createRange();
      range.selectNodeContents(els['diag-log']);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast('Select-all done - press copy', true);
    }
  });
  if (params.get('debug')) els.diag.hidden = false;

  diag(`page loaded · secure=${typeof window !== 'undefined' && window.isSecureContext} · bluetooth API=${typeof navigator !== 'undefined' && !!navigator.bluetooth}`);
  if (typeof navigator !== 'undefined' && navigator.bluetooth && navigator.bluetooth.getAvailability) {
    navigator.bluetooth.getAvailability().then((ok) => diag(`bluetooth adapter available=${ok}`)).catch(() => {});
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
    els.connect.hidden = connected || stateName === 'reconnecting' || stateName === 'connecting' || stateName === 'calibrating';
    els.disconnect.hidden = els.connect.hidden === false;
    els.demo.hidden = !els.connect.hidden ? false : true;
    els.capture.disabled = !connected;
    if (stateName === 'disconnected') {
      els.model.hidden = true;
      els.battery.hidden = true;
      els.uncal.hidden = true;
    }
  }

  function attach(meter, simulated) {
    if (state.meter && state.meter !== meter) {
      try {
        state.meter.disconnect();
      } catch (_) {
        // ignore
      }
    }
    state.meter = meter;
    state.simulated = simulated;
    state.rawHistory = [];
    meter.addEventListener('log', (e) => diag(e.detail.message, e.detail.level, e.detail.ts));
    meter.addEventListener('status', (e) => {
      if (state.meter !== meter) return;
      setStatus(e.detail.state, e.detail.message);
      if (e.detail.state === 'connected') {
        els.model.textContent = meter.modelName();
        els.model.hidden = false;
        els.uncal.hidden = !!(meter.calibration && meter.calibration.kSensor);
      }
      if (e.detail.state === 'warning') toast(e.detail.message, true);
    });
    meter.addEventListener('reading', (e) => {
      if (state.meter === meter) onReading(e.detail);
    });
    meter.addEventListener('disconnected', () => {
      if (state.meter !== meter) return;
      state.meter = null;
      state.live = null;
      if (state.capture) {
        const c = state.capture;
        state.capture = null;
        c.reject(new Error('Meter disconnected during capture'));
        els.capture.textContent = 'Log reading';
      }
      renderLive(null);
    });
  }

  async function connectReal() {
    const meter = new OppleMeter({ verbose: state.verbose });
    attach(meter, false);
    els.connect.disabled = true;
    try {
      await meter.connect();
      meter.startPolling(500);
      toast(`${meter.modelName()} connected${meter.calibration ? ' - calibration loaded' : ''}`);
    } catch (err) {
      if (state.meter === meter) state.meter = null;
      const cancelled = err && (err.name === 'NotFoundError' || /cancel/i.test(err.message));
      diag(`connect failed: ${err.name || 'Error'}: ${err.message}`, cancelled ? 'info' : 'error');
      setStatus('disconnected', cancelled ? 'No meter chosen' : `Connection failed - ${err.message}`);
      if (!cancelled) toast(`${err.message}. Open Diagnostics for details.`, true);
    } finally {
      els.connect.disabled = !support.ok;
    }
  }

  function connectDemo() {
    const meter = new SimulatedMeter();
    attach(meter, true);
    meter.connect().then(() => {
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
      els.capture.textContent = `Averaging… ${n}/${CAPTURE_SAMPLES}`;
      if (n >= CAPTURE_SAMPLES) {
        const avg = processMeasurement({ model: reading.model, raw: averageRaw(state.capture.samples), batteryRaw: 0 }, cal);
        const done = state.capture;
        state.capture = null;
        els.capture.textContent = 'Log reading';
        els.capture.disabled = false;
        done.resolve(avg);
      }
    }
  }

  function captureAverage() {
    if (!state.meter || !state.meter.connected) return Promise.reject(new Error('Connect a meter first'));
    if (state.capture) return Promise.reject(new Error('Already capturing'));
    els.capture.disabled = true;
    return new Promise((resolve, reject) => {
      state.capture = { samples: [], resolve, reject };
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

  // -- reading log ----------------------------------------------------------
  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = els.label.value.trim() || `Reading ${state.readings.length + 1}`;
    try {
      const r = await captureAverage();
      if (!(r.lux > 0) || !Number.isFinite(r.cct)) {
        toast('No light reaching the sensor', true);
        return;
      }
      state.readings.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        label,
        model: r.model,
        simulated: state.simulated,
        cct: r.cct,
        lux: r.lux,
        duv: r.duv,
        tint: r.tint,
        x: r.x,
        y: r.y,
        Ra: r.Ra,
        R: r.R,
        eml: r.eml,
        cs: r.cs,
      });
      store.set(STORAGE.log, state.readings);
      renderReadings();
      els.label.value = '';
      toast(`Logged ${fmt.int(r.cct)} K · ${fmt.lux(r.lux)} lux`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  els.clear.addEventListener('click', () => {
    state.readings = [];
    store.set(STORAGE.log, state.readings);
    renderReadings();
  });

  els.export.addEventListener('click', () => {
    const cols = ['time', 'label', 'cct_k', 'lux', 'duv', 'tint', 'x', 'y', 'cri_ra', ...Array.from({ length: 14 }, (_, i) => `r${i + 1}`), 'eml', 'cs', 'meter', 'simulated'];
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [cols.join(',')];
    for (const c of state.readings) {
      lines.push(
        [
          new Date(c.ts).toISOString(),
          q(c.label),
          c.cct.toFixed(0),
          c.lux.toFixed(1),
          c.duv.toFixed(4),
          Number.isFinite(c.tint) ? c.tint.toFixed(1) : '',
          c.x.toFixed(4),
          c.y.toFixed(4),
          c.Ra === null ? '' : c.Ra.toFixed(1),
          ...Array.from({ length: 14 }, (_, i) => (c.R ? c.R[i].toFixed(1) : '')),
          c.eml === null || c.eml === undefined ? '' : c.eml.toFixed(0),
          c.cs === null || c.cs === undefined ? '' : c.cs.toFixed(3),
          c.model,
          c.simulated ? 'yes' : 'no',
        ].join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `light-meter-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  });

  function renderReadings() {
    const rows = state.readings;
    els.results.hidden = rows.length === 0;
    els.rows.innerHTML = rows
      .slice()
      .reverse()
      .map(
        (c) => `<tr>
          <td class="slm__label">${esc(c.label)}</td>
          <td><b>${fmt.int(c.cct)} K</b></td>
          <td>${fmt.lux(c.lux)}</td>
          <td>${fmt.signed(c.duv, 4)}</td>
          <td>${fmt.signed(c.tint, 0)}</td>
          <td>${fmt.fixed(c.Ra, 1)}</td>
          <td>${c.R ? fmt.fixed(c.R[8], 1) : '–'}</td>
          <td>${fmt.int(c.eml)}</td>
          <td class="slm__muted">${c.x.toFixed(4)}, ${c.y.toFixed(4)}</td>
          <td class="slm__muted">${fmt.time(c.ts)}${c.simulated ? ' <small>sim</small>' : ''}</td>
          <td><button type="button" class="slm__x" data-remove="${c.id}" aria-label="Remove">×</button></td>
        </tr>`,
      )
      .join('');
    els.rows.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => {
        state.readings = state.readings.filter((c) => c.id !== b.dataset.remove);
        store.set(STORAGE.log, state.readings);
        renderReadings();
      });
    });
    els.summary.innerHTML = `<b>${rows.length}</b> reading${rows.length === 1 ? '' : 's'} saved in this browser`;
  }

  renderLive(null);
  renderReadings();
  renderDiag();
  setStatus('disconnected', 'Not connected');

  if (params.get('demo') === '1') connectDemo();
  return { state, diagText };
}

if (typeof window !== 'undefined') {
  window.SundayLightMeter = { mount };
  const auto = document.getElementById('sunday-light-meter');
  if (auto) window.SundayLightMeter.app = mount(auto);
}
