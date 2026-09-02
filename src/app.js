// Light Meter - page controller.
//
// Mounts into a root element, talks to an Opple Light Master over Web
// Bluetooth (see meter.js) and renders the live readout, a reading log
// with CSV export, and a diagnostics panel.

import { OppleMeter, bluetoothSupport, processMeasurement, releasePermittedDevices, advertisingState } from './meter.js';
import { cctToCss, wavelengthToCss } from './colour.js';

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
// Markup
// ---------------------------------------------------------------------------

function template() {
  return `
<div class="slm__notice" data-el="support" hidden></div>

<section class="slm__connect" aria-label="Meter connection">
  <div class="slm__connect-left">
    <button class="slm__btn slm__btn--primary" type="button" data-el="connect">Connect light meter</button>
    <button class="slm__btn slm__btn--ghost" type="button" data-el="disconnect" hidden>Disconnect</button>
  </div>
  <div class="slm__status" data-el="status">
    <span class="slm__dot" data-el="dot"></span>
    <span data-el="status-text">Not connected</span>
    <span class="slm__chip" data-el="model" hidden></span>
    <span class="slm__chip" data-el="battery" hidden></span>
    <span class="slm__chip slm__chip--warn" data-el="uncal" hidden title="The meter did not return its calibration factors - readings are raw">uncalibrated</span>
  </div>
  <details class="slm__help" data-el="help">
    <summary class="slm__help-toggle">Trouble connecting?</summary>
    <div class="slm__help-panel">
      <button class="slm__btn slm__btn--link" type="button" data-el="connect-all">Not listed? Show all devices</button>
      <p class="slm__help-note">Chrome only lists devices that look like a Light Master; this shows everything in range.</p>
      <button class="slm__btn slm__btn--link" type="button" data-el="force">Meter stuck? Force disconnect</button>
    </div>
  </details>
</section>

<div class="slm__notice slm__notice--reset" data-el="reset" hidden></div>

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
  <p>Opple Light Master 3 and 4 · Chrome, Edge or Android (iPhone: <a href="https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055" rel="noopener" target="_blank">Bluefy</a>) · <a href="https://github.com/natmart-in/sunday-light-meter" rel="noopener" target="_blank">Open source on GitHub</a> · <button type="button" class="slm__btn slm__btn--link" data-el="diag-toggle">Diagnostics</button></p>
  <p class="slm__credits">Built on <a href="https://github.com/OlliV/open-light-master" rel="noopener" target="_blank">open-light-master</a> (Light Master 3 protocol and maths) and <a href="https://github.com/gabrielebaudo/opple-bridge" rel="noopener" target="_blank">opple-bridge</a> (Light Master 4 payloads and the app's coefficients), with notes from <a href="https://github.com/Geomaniac15/tag-tester" rel="noopener" target="_blank">tag-tester</a>. Not affiliated with Opple.</p>
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
    if (state.meter) state.meter.verbose = state.verbose;
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
        : 'This browser cannot talk to Bluetooth devices. Open this page in <b>Chrome</b> or <b>Edge</b> on a computer or Android phone, or in the <b>Bluefy</b> browser on iPhone/iPad.';
    els.connect.disabled = true;
    els.help.hidden = true;
  }

  // -- connection -----------------------------------------------------------
  function setStatus(stateName, message) {
    els['status-text'].textContent = message;
    els.dot.className = `slm__dot slm__dot--${stateName}`;
    const connected = stateName === 'connected';
    const busy = stateName === 'reconnecting' || stateName === 'connecting' || stateName === 'calibrating' || stateName === 'requesting';
    els.connect.hidden = connected || busy;
    els.disconnect.hidden = !(connected || busy);
    // The fallbacks only help while disconnected, so the whole "Trouble
    // connecting?" disclosure goes away once a meter is connected or an attempt
    // is in flight. A failed attempt lands back on 'disconnected', which brings
    // it back - still open, so the fallbacks are one click away.
    els.help.hidden = connected || busy || !support.ok;
    if (connected) els.help.open = false;
    els.capture.disabled = !connected;
    if (stateName === 'disconnected') {
      els.model.hidden = true;
      els.battery.hidden = true;
      els.uncal.hidden = true;
    }
  }

  function attach(meter) {
    if (state.meter && state.meter !== meter) {
      try {
        state.meter.disconnect();
      } catch (_) {
        // ignore
      }
    }
    state.meter = meter;
    state.rawHistory = [];
    meter.addEventListener('log', (e) => diag(e.detail.message, e.detail.level, e.detail.ts));
    meter.addEventListener('status', (e) => {
      if (state.meter !== meter) return;
      setStatus(e.detail.state, e.detail.message);
      if (e.detail.state === 'connected') {
        els.model.textContent = meter.modelName();
        els.model.hidden = false;
        els.uncal.hidden = !!(meter.calibration && meter.calibration.kSensor);
        els.reset.hidden = true;
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

  async function connectReal(showAll = false) {
    const meter = new OppleMeter({ verbose: state.verbose });
    attach(meter);
    els.connect.disabled = true;
    els['connect-all'].disabled = true;
    try {
      await meter.connect({ showAll });
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
      els['connect-all'].disabled = !support.ok;
    }
  }

  els.connect.addEventListener('click', () => connectReal(false));
  els['connect-all'].addEventListener('click', () => connectReal(true));
  els.disconnect.addEventListener('click', () => {
    if (state.meter) state.meter.disconnect();
  });

  // -- force disconnect -----------------------------------------------------
  async function forceDisconnect() {
    els.force.disabled = true;
    els.reset.hidden = false;
    els.reset.innerHTML = 'Releasing…';
    diag('force disconnect requested');
    if (state.meter) {
      try {
        state.meter.disconnect();
      } catch (_) {
        // ignore
      }
    }
    const res = await releasePermittedDevices({ forget: true, log: diag });
    const meterLike = res.devices.filter((d) => /sigmesh|opple|master/i.test(d.name));
    const lines = [];
    if (!res.supported) {
      lines.push('Released this tab’s own link. This browser cannot list previously allowed meters (in Chrome, <code>chrome://flags/#enable-web-bluetooth-new-permissions-backend</code> turns that on), so anything another tab holds must be closed there.');
    } else if (res.devices.length === 0) {
      lines.push('This site holds no meter permissions, so it is not what has the meter.');
    } else {
      lines.push(`Released ${res.devices.length} previously allowed device${res.devices.length === 1 ? '' : 's'} (${res.devices.map((d) => esc(d.name)).join(', ')}) and cleared the permission - the next Connect will ask again.`);
    }
    // Is the meter free now? A connected Light Master does not advertise.
    const probe = meterLike[0] || res.devices[0];
    if (probe && typeof probe.device.watchAdvertisements === 'function') {
      els.reset.innerHTML = `${lines.join(' ')}<br>Listening for the meter for 6 seconds…`;
      const adv = await advertisingState(probe.device, 6000, diag);
      if (adv === 'seen') lines.push(`<b>${esc(probe.name)} is advertising</b> - it is free. Press Connect.`);
      else if (adv === 'silent') lines.push(`<b>${esc(probe.name)} is not advertising</b> - something still holds it, or it is asleep.`);
      diag(`advertising check: ${adv}`);
    }
    lines.push(
      'If it still shows as connected or “Paired” in the chooser: <b>1</b> close every other tab with this page, then quit the browser completely (on a Mac, ⌘Q - a stale link lives inside the browser process), <b>2</b> quit the Opple app on your phone, <b>3</b> turn Bluetooth off and on, <b>4</b> hold the meter’s power button to restart it. A web page cannot reach a link held by another app or the meter itself.',
    );
    els.reset.innerHTML = lines.join(' ');
    els.force.disabled = false;
  }
  els.force.addEventListener('click', () => {
    forceDisconnect().catch((err) => {
      diag(`force disconnect: ${err.message}`, 'error');
      els.force.disabled = false;
    });
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
    // Bars and labels are separate rows so a bar's percentage height resolves
    // against the full bar track, not the track minus the label.
    const bars = r.bandWavelengths
      .map((wl, i) => {
        const h = Math.max(2, (100 * r.bands[i]) / max);
        return `<div class="slm__band-bar" title="${wl} nm" style="height:${h.toFixed(1)}%;background:${wavelengthToCss(wl)}"></div>`;
      })
      .join('');
    const labels = r.bandWavelengths.map((wl) => `<span>${wl}</span>`).join('');
    // The caption is rendered inside the host so `.slm__spectrum:empty` still
    // collapses the whole row when there is no reading.
    host.innerHTML = `<p class="slm__spectrum-caption">Sensor bands, nm - relative response per band</p><div class="slm__spectrum-bars">${bars}</div><div class="slm__spectrum-labels">${labels}</div>`;
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
    const cols = ['time', 'label', 'cct_k', 'lux', 'duv', 'tint', 'x', 'y', 'cri_ra', ...Array.from({ length: 14 }, (_, i) => `r${i + 1}`), 'eml', 'cs', 'meter'];
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
        // data-th carries the column name so the narrow-screen card layout can
        // print it with ::before once the header row is hidden.
        (c) => `<tr>
          <td class="slm__label" data-th="Label">${esc(c.label)}</td>
          <td class="slm__cell--key" data-th="CCT"><b>${fmt.int(c.cct)} K</b></td>
          <td class="slm__cell--key" data-th="Lux">${fmt.lux(c.lux)}</td>
          <td data-th="Duv">${fmt.signed(c.duv, 4)}</td>
          <td data-th="Tint">${fmt.signed(c.tint, 0)}</td>
          <td data-th="Ra">${fmt.fixed(c.Ra, 1)}</td>
          <td data-th="R9">${c.R ? fmt.fixed(c.R[8], 1) : '–'}</td>
          <td data-th="EML">${fmt.int(c.eml)}</td>
          <td class="slm__muted slm__cell--xy" data-th="x, y">${c.x.toFixed(4)}, ${c.y.toFixed(4)}</td>
          <td class="slm__muted" data-th="Time">${fmt.time(c.ts)}</td>
          <td class="slm__cell--x"><button type="button" class="slm__x" data-remove="${c.id}" aria-label="Remove">×</button></td>
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
  return { state, diagText };
}

if (typeof window !== 'undefined') {
  window.SundayLightMeter = { mount };
  const auto = document.getElementById('sunday-light-meter');
  if (auto) window.SundayLightMeter.app = mount(auto);
}
