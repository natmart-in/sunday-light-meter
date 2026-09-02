// Web Bluetooth session with an Opple Light Master 3 or 4.
//
// Usage:
//   const meter = new OppleMeter();
//   meter.addEventListener('reading', (e) => console.log(e.detail));
//   await meter.connect();      // must be called from a user gesture
//   meter.startPolling(500);
//
// Events: 'status' {state, message}, 'reading' (processed measurement),
// 'log' {ts, level, message}, 'disconnected'.

import { NUS_SERVICE, NUS_TX, NUS_RX, OPCODE, buildCommand, encapsulate, MessageAssembler, opcodeOf, parseMeasurement, parseCalibration } from './protocol.js';
import { lm3Process, lm3Calibrate, lm3Battery } from './lm3.js';
import { lm4Process, lm4Calibrate, lm4Battery } from './lm4.js';
import { FlickerAssembler, flickerBody, analyseFlicker, nextPeriod, bestResult, FLICKER_PERIODS } from './flicker.js';

export const REQUEST_OPTIONS = {
  filters: [
    { services: [NUS_SERVICE] },
    { namePrefix: 'SigMesh' }, // Light Master 4 advertises as "SigMesh"
    { namePrefix: 'LightMaster' }, // Light Master 3 advertises as "LightMaster"
    { namePrefix: 'Light Master' },
    { namePrefix: 'LMaster' },
    { namePrefix: 'Opple' },
    { namePrefix: 'LM3' },
    { namePrefix: 'LM4' },
  ],
  optionalServices: [NUS_SERVICE, 'battery_service'],
};

/** Fallback chooser for meters advertising under an unexpected name: every device, no filter. */
export const REQUEST_OPTIONS_ALL = {
  acceptAllDevices: true,
  optionalServices: [NUS_SERVICE, 'battery_service'],
};

const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 3000;
const FLICKER_TIMEOUT_MS = 10000;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const RECONNECT_ATTEMPTS = 3;

export function bluetoothSupport() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    return { ok: false, reason: 'no-api' };
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, reason: 'insecure' };
  }
  return { ok: true };
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

/**
 * Devices this site has been allowed to use before (Chrome's persistent
 * Web Bluetooth permissions). Empty where the API is unavailable.
 */
export async function permittedDevices() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') return [];
  try {
    return await navigator.bluetooth.getDevices();
  } catch (_) {
    return [];
  }
}

/**
 * Drop every GATT link (and cancel every pending connect) this page holds
 * on previously permitted meters. Optionally revoke the permission too so
 * the next Connect shows a fresh chooser. Returns what was done.
 */
export async function releasePermittedDevices({ forget = false, log = () => {} } = {}) {
  const devices = await permittedDevices();
  const result = { supported: typeof navigator !== 'undefined' && !!navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function', devices: [], released: 0, forgotten: 0 };
  for (const d of devices) {
    const name = d.name || '(no name)';
    const wasConnected = !!(d.gatt && d.gatt.connected);
    result.devices.push({ name, id: d.id, wasConnected, device: d });
    try {
      if (d.gatt) d.gatt.disconnect();
      if (wasConnected) result.released += 1;
      log(`released ${name}${wasConnected ? ' (was connected in this tab)' : ' (no link in this tab)'}`);
    } catch (err) {
      log(`release ${name}: ${err.message}`, 'warn');
    }
    if (forget && typeof d.forget === 'function') {
      try {
        await d.forget();
        result.forgotten += 1;
        log(`forgot ${name} - it will ask for permission again`);
      } catch (err) {
        log(`forget ${name}: ${err.message}`, 'warn');
      }
    }
  }
  return result;
}

/**
 * Listen for advertisements from a permitted device for `ms`. A Light
 * Master that is connected to anything does not advertise, so "seen"
 * means it is free to connect. Returns 'seen' | 'silent' | 'unsupported'.
 */
export async function advertisingState(device, ms = 6000, log = () => {}) {
  if (!device || typeof device.watchAdvertisements !== 'function') return 'unsupported';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const seen = new Promise((resolve) => {
      device.addEventListener('advertisementreceived', (e) => {
        log(`advertisement from ${device.name || '(no name)'} rssi=${e.rssi}`);
        resolve('seen');
      }, { once: true });
    });
    await device.watchAdvertisements({ signal: ctrl.signal });
    const aborted = new Promise((resolve) => ctrl.signal.addEventListener('abort', () => resolve('silent'), { once: true }));
    const state = await Promise.race([seen, aborted]);
    return state;
  } catch (err) {
    log(`advertisement watch: ${err.message}`, 'warn');
    return 'unsupported';
  } finally {
    clearTimeout(timer);
    if (!ctrl.signal.aborted) ctrl.abort();
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const LUX_FACTOR_MIN = 0.5;
export const LUX_FACTOR_MAX = 2;

/** A user lux calibration factor, or 1 if it is missing or outside 0.5-2. */
export function sanitiseLuxFactor(v) {
  const f = Number(v);
  return Number.isFinite(f) && f >= LUX_FACTOR_MIN && f <= LUX_FACTOR_MAX ? f : 1;
}

/**
 * Key for per-meter settings. Light Masters advertise as "LMaster_xxxx" with the
 * last MAC bytes, which is unique per unit; otherwise fall back to the browser's
 * device id (stable for this origin).
 */
export function meterKey(model, device) {
  if (!device) return null;
  const name = device.name || '';
  const id = /_[0-9a-f]{4}$/i.test(name) ? name : device.id || name;
  return id ? `${model || 'meter'}:${id}` : null;
}

/**
 * Turn a raw measurement + calibration into the full processed reading.
 * `luxFactor` is an optional user calibration (from a reference lux meter): it
 * scales the calibrated channels, so lux, EML and CS scale with it and the
 * colour results (CCT, Duv, CRI) are unchanged.
 */
export function processMeasurement(meas, cal, { luxFactor = 1 } = {}) {
  const kSensor = cal && cal.kSensor ? cal.kSensor : null;
  const factor = sanitiseLuxFactor(luxFactor);
  if (meas.model === 'lm4') {
    const { channels } = lm4Calibrate(meas.raw, kSensor || new Array(9).fill(1));
    const reading = lm4Process(channels.map((c) => c * factor));
    return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, luxFactor: factor, battery: lm4Battery(meas.batteryRaw), temperature: null, nir: meas.nir ?? null, ts: Date.now() };
  }
  const { channels, c1 } = lm3Calibrate(meas.raw, kSensor || new Array(7).fill(1));
  const reading = lm3Process(channels.map((c) => c * factor), c1);
  return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, luxFactor: factor, battery: lm3Battery(meas.batteryRaw), temperature: meas.temperature, ts: Date.now() };
}

export class OppleMeter extends EventTarget {
  constructor({ verbose = false } = {}) {
    super();
    this.verbose = verbose;
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.seq = 0;
    this.assembler = new MessageAssembler();
    this.pending = null; // { opcode, resolve, reject, timer, sentAt }
    this.flicker = null; // { assembler, period, resolve, reject, timer } - see requestFlicker
    this.calibration = null;
    this.model = null;
    this.pollTimer = null;
    this.pollInterval = 500;
    this.inFlight = false;
    this.consecutiveTimeouts = 0;
    this.manualDisconnect = false;
    this.reconnecting = false;
    this.established = false; // auto-reconnect only once a session has fully opened
    this.onNotify = this.onNotify.bind(this);
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  get connected() {
    return !!(this.server && this.server.connected && this.writeChar);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(message, level = 'info') {
    this.emit('log', { ts: Date.now(), level, message });
  }

  debug(message) {
    if (this.verbose) this.log(message, 'debug');
  }

  status(state, message) {
    this.log(`${state}: ${message}`);
    this.emit('status', { state, message });
  }

  /** Prompt for a meter and open the session. Must run inside a user gesture. */
  async connect({ showAll = false } = {}) {
    const support = bluetoothSupport();
    if (!support.ok) throw new Error(support.reason === 'insecure' ? 'Web Bluetooth needs an https page' : 'This browser has no Web Bluetooth (use Chrome or Edge)');
    this.status('requesting', showAll ? 'Choose your meter from all Bluetooth devices' : 'Choose your Light Master in the browser dialog');
    const device = await navigator.bluetooth.requestDevice(showAll ? REQUEST_OPTIONS_ALL : REQUEST_OPTIONS);
    if (device.gatt && device.gatt.connected) this.log('browser already reports this device as connected before we asked - a stale link from an earlier session', 'warn');
    this.device = device;
    this.manualDisconnect = false;
    this.log(`chosen device "${device.name || '(no name)'}" id=${device.id}`);
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    try {
      await this.openSession();
    } catch (err) {
      this.log(`session failed: ${err.name || ''} ${err.message}`, 'error');
      // Never leave a half-open link behind: it would keep the meter busy and
      // show up as "Paired"/connected in the next chooser. Retire this session
      // too - the device object is shared with the next Connect, and a failed
      // session still listening on it would reconnect behind the page's back.
      this.dispose();
      throw err;
    }
    this.established = true;
    return this.info();
  }

  async openSession() {
    const name = this.device.name || 'Light Master';
    this.status('connecting', `Connecting to ${name}`);
    try {
      this.server = await withTimeout(this.device.gatt.connect(), CONNECT_TIMEOUT_MS, 'GATT connect');
    } catch (err) {
      // A connect that timed out is still pending inside the browser and would
      // grab the meter the moment it advertises - cancel it explicitly.
      this.cancelPendingConnect();
      throw err;
    }
    this.log('GATT connected, discovering the UART service');
    const service = await withTimeout(this.server.getPrimaryService(NUS_SERVICE), CONNECT_TIMEOUT_MS, 'service discovery');
    const tx = await service.getCharacteristic(NUS_TX);
    let rx = null;
    try {
      rx = await service.getCharacteristic(NUS_RX);
    } catch (_) {
      rx = null;
    }
    const props = (c) => (c ? Object.keys(c.properties).filter((k) => c.properties[k]).join(',') : 'absent');
    this.log(`TX 0003 props=[${props(tx)}] RX 0002 props=[${props(rx)}]`);
    // Opple meters take commands on the notify characteristic; fall back to classic NUS RX.
    if (tx.properties.write || tx.properties.writeWithoutResponse) this.writeChar = tx;
    else if (rx) this.writeChar = rx;
    else throw new Error('No writable characteristic on this device');
    this.notifyChar = tx;
    this.assembler.reset();
    this.pending = null;
    tx.addEventListener('characteristicvaluechanged', this.onNotify);
    await withTimeout(tx.startNotifications(), CONNECT_TIMEOUT_MS, 'notification subscribe');
    this.log(`notifications on, writing commands to ${this.writeChar === tx ? '0003' : '0002'}`);

    this.status('calibrating', 'Reading sensor calibration');
    this.calibration = await this.readCalibration();
    if (this.calibration) {
      this.model = this.calibration.model;
      this.log(`calibration: ${this.calibration.kSensor.length} factors (${this.calibration.model}) = ${this.calibration.kSensor.map((k) => k.toFixed(4)).join(', ')}`);
    } else {
      this.log('calibration read failed twice - continuing with raw counts', 'warn');
    }
    // A first measurement settles the model detection (the payload length is authoritative).
    const first = await this.measureRaw(4000);
    this.model = first.model;
    this.log(`first measurement: ${first.model} raw=[${first.raw.join(', ')}] battery=${first.batteryRaw}`);
    if (this.calibration && this.calibration.model !== first.model) {
      const need = first.model === 'lm4' ? 9 : 7;
      const k = this.calibration.kSensor.slice(0, need);
      while (k.length < need) k.push(1);
      this.calibration = { model: first.model, kSensor: k };
      this.log(`calibration length did not match the ${first.model} payload - adjusted to ${need} factors`, 'warn');
    }
    this.consecutiveTimeouts = 0;
    this.status('connected', `${this.modelName()} connected`);
    this.emit('reading', processMeasurement(first, this.calibration));
  }

  modelName() {
    return this.model === 'lm4' ? 'Light Master 4' : this.model === 'lm3' ? 'Light Master 3' : 'Light Master';
  }

  info() {
    return {
      name: this.device ? this.device.name : null,
      model: this.model,
      modelName: this.modelName(),
      kSensor: this.calibration ? this.calibration.kSensor : null,
    };
  }

  async readCalibration() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const msg = await this.command(OPCODE.REQ_CAL, OPCODE.RES_CAL, COMMAND_TIMEOUT_MS);
        const cal = parseCalibration(msg);
        if (cal) return cal;
        this.log(`calibration response too short (${msg.length} bytes)`, 'warn');
      } catch (err) {
        this.log(`calibration attempt ${attempt + 1}: ${err.message}`, 'warn');
      }
    }
    return null;
  }

  async measureRaw(timeout = COMMAND_TIMEOUT_MS) {
    const msg = await this.command(OPCODE.REQ_MEAS, OPCODE.RES_MEAS, timeout);
    const meas = parseMeasurement(msg);
    if (!meas) throw new Error(`Unparseable measurement (${msg.length} bytes)`);
    return meas;
  }

  /** One calibrated, processed reading. */
  async measure(timeout = COMMAND_TIMEOUT_MS) {
    const meas = await this.measureRaw(timeout);
    return processMeasurement(meas, this.calibration);
  }

  /**
   * Wait for the single command slot to free up, rather than rejecting the
   * instant it is busy.
   *
   * A poll tick that was already in flight when polling stopped keeps its
   * `pending` slot for up to its own timeout, so the second pass of the
   * cascade was refused outright 1 ms after the first one finished
   * ("Command already in flight", seen repeatedly on an LM4). Waiting is
   * correct: the slot always frees, and a capture that starts 200 ms late is
   * still a capture.
   */
  async waitForSlot(ms = 3500) {
    const deadline = Date.now() + ms;
    while ((this.pending || this.flicker || this.inFlight) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return !(this.pending || this.flicker || this.inFlight);
  }

  /**
   * One flicker capture at a given sampling period. Resolves with the analysed
   * result (see flicker.js). Slower than a measurement - the meter samples for
   * up to ~150 ms and then sends four chunks - so it gets its own timeout.
   */
  async requestFlicker(period = FLICKER_PERIODS.broad, timeout = FLICKER_TIMEOUT_MS) {
    if (!this.connected) throw new Error('Not connected');
    if (!(await this.waitForSlot())) {
      throw new Error(this.flicker ? 'Flicker capture already in flight' : 'Command already in flight');
    }
    if (!this.connected) throw new Error('Not connected');
    this.seq = (this.seq + 1) & 0xff;
    const frames = encapsulate(buildCommand(OPCODE.REQ_FREQ, this.seq, flickerBody(period)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pages = this.flicker ? this.flicker.assembler.pages.size : 0;
        this.flicker = null;
        // A page can still be in flight from the pass that just died. Anything
        // arriving in this window belongs to it, not to the next capture -
        // mixing pages from two sampling rates makes a waveform that analyses
        // as convincing broadband flicker.
        this.flickerDrainUntil = Date.now() + 500;
        reject(new Error(`Flicker capture timed out (${pages}/4 chunks arrived)`));
      }, timeout);
      this.flicker = { assembler: new FlickerAssembler(this.model || 'lm4'), period, resolve, reject, timer };
      this.writeFrames(frames).catch((err) => {
        clearTimeout(timer);
        this.flicker = null;
        reject(err);
      });
    });
  }

  /**
   * The Opple app's three-stage cascade. No single sampling mode resolves both
   * mains-frequency PWM and switching ripple, so it starts broad and escalates
   * only when the broad pass says the flicker is fast. `onStage` reports each
   * pass so the UI can show progress.
   */
  async measureFlicker({ onStage = () => {} } = {}) {
    const wasPolling = !!this.pollTimer;
    this.stopPolling();
    // A measurement in flight would collide with the capture: the meter
    // answers one command at a time.
    for (let i = 0; i < 20 && this.inFlight; i++) await new Promise((r) => setTimeout(r, 50));
    try {
      const results = {};
      const done = [];
      for (let guard = 0; guard < 3; guard++) {
        const period = nextPeriod(done, results);
        if (period === null) break;
        onStage({ period, index: done.length });
        this.log(`flicker capture at period ${period}`);
        try {
          const result = await this.requestFlicker(period);
          results[period] = result;
          // Raw span and range are logged on every pass because they are what
          // tell a clipped capture from a genuinely flat one, and the question
          // only ever comes up after the capture is gone.
          this.log(
            `flicker period ${period}: ${result.frequency.toFixed(0)} Hz, ${result.modulationDepth.toFixed(2)}% depth, index ${result.flickerIndex.toFixed(4)}` +
              ` · raw ${result.rawMin}-${result.rawMax}/4095 counts, range ${result.range}`,
          );
        } catch (err) {
          // One failed pass must not throw away what the others measured - the
          // broad pass alone is a complete, reportable result.
          this.log(`flicker period ${period} failed: ${err.message}`, 'warn');
        }
        done.push(period);
      }
      const best = bestResult(results);
      if (!best) throw new Error('No flicker data returned');
      return { ...best, passes: results };
    } finally {
      if (wasPolling) this.startPolling(this.pollInterval);
    }
  }

  command(opcode, responseOpcode, timeout = COMMAND_TIMEOUT_MS, body = new Uint8Array(0)) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    if (this.pending) return Promise.reject(new Error('Command already in flight'));
    this.seq = (this.seq + 1) & 0xff;
    const frames = encapsulate(buildCommand(opcode, this.seq, body));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('Meter did not answer (is it awake?)'));
      }, timeout);
      this.pending = { opcode: responseOpcode, resolve, reject, timer, sentAt: performance.now() };
      this.writeFrames(frames).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      });
    });
  }

  async writeFrames(frames) {
    for (const f of frames) {
      this.debug(`> ${hex(f)}`);
      const c = this.writeChar;
      if (c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === 'function') {
        try {
          await c.writeValueWithoutResponse(f);
          continue;
        } catch (err) {
          if (!c.properties.write) throw err;
          this.log(`write-without-response failed (${err.message}); using write-with-response`, 'warn');
        }
      }
      if (typeof c.writeValueWithResponse === 'function') await c.writeValueWithResponse(f);
      else await c.writeValue(f);
    }
  }

  onNotify(event) {
    const dv = event.target.value;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    this.debug(`< ${hex(bytes)}`);
    const msg = this.assembler.feed(bytes);
    if (!msg) return;
    const code = opcodeOf(msg);
    // Flicker is the one chunked response: four RES_FREQ messages make one
    // waveform, so it cannot go through the single-response `pending` path.
    if (code === OPCODE.RES_FREQ) {
      if (this.flickerDrainUntil && Date.now() < this.flickerDrainUntil) {
        this.debug('flicker chunk from a timed-out capture - dropped');
        return;
      }
      if (!this.flicker) {
        this.debug('stray flicker chunk (no capture in flight)');
        return;
      }
      const capture = this.flicker.assembler.feed(msg);
      if (!capture) return;
      const f = this.flicker;
      this.flicker = null;
      clearTimeout(f.timer);
      if (capture.slack !== 0) {
        // Non-zero means the waveform offset for this model is wrong for this
        // firmware; the samples will be garbage. Loud, because the numbers
        // would still look plausible.
        this.log(`flicker chunk layout unexpected: ${capture.slack} spare bytes - readings may be wrong`, 'warn');
      }
      f.resolve(analyseFlicker(capture, f.period));
      return;
    }
    if (this.pending && code === this.pending.opcode) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      this.debug(`response 0x${code.toString(16)} ${msg.length} bytes in ${Math.round(performance.now() - p.sentAt)} ms`);
      p.resolve(msg);
    } else {
      this.debug(`ignored message opcode=0x${code.toString(16)} len=${msg.length}${this.pending ? ` (waiting for 0x${this.pending.opcode.toString(16)})` : ''}`);
    }
  }

  startPolling(intervalMs = 500) {
    this.pollInterval = intervalMs;
    this.stopPolling();
    const tick = async () => {
      if (!this.connected) return;
      if (!this.inFlight) {
        this.inFlight = true;
        try {
          const reading = await this.measure(COMMAND_TIMEOUT_MS);
          this.consecutiveTimeouts = 0;
          this.emit('reading', reading);
        } catch (err) {
          this.consecutiveTimeouts += 1;
          this.log(`poll: ${err.message} (${this.consecutiveTimeouts}/${MAX_CONSECUTIVE_TIMEOUTS})`, 'warn');
          if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
            this.inFlight = false;
            this.status('warning', 'Meter stopped answering - reconnecting');
            this.recycleLink();
            return;
          }
          this.status('warning', err.message);
        } finally {
          this.inFlight = false;
        }
      }
      this.pollTimer = setTimeout(tick, this.pollInterval);
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  stopPolling() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Drop the GATT link if up, and cancel a pending connect if not. Safe to call any time. */
  cancelPendingConnect() {
    try {
      if (this.device && this.device.gatt) {
        if (this.device.gatt.connected) this.log('dropping the GATT link');
        this.device.gatt.disconnect();
      }
    } catch (_) {
      // ignore
    }
  }

  /** Drop a link that is up but silent; the disconnect handler then reconnects. */
  recycleLink() {
    this.stopPolling();
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.onGattDisconnected();
  }

  /** Retire this session for good: no auto-reconnect, off the device's events, link dropped. */
  dispose() {
    this.manualDisconnect = true;
    if (this.device) this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.teardown();
    this.cancelPendingConnect();
  }

  teardown() {
    this.stopPolling();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Disconnected'));
      this.pending = null;
    }
    if (this.flicker) {
      clearTimeout(this.flicker.timer);
      this.flicker.reject(new Error('Disconnected'));
      this.flicker = null;
    }
    if (this.notifyChar) {
      try {
        this.notifyChar.removeEventListener('characteristicvaluechanged', this.onNotify);
      } catch (_) {
        // ignore
      }
    }
    this.writeChar = null;
    this.notifyChar = null;
    this.inFlight = false;
  }

  async onGattDisconnected() {
    this.log('GATT link dropped', this.manualDisconnect ? 'info' : 'warn');
    this.teardown();
    // A link lost while the first session is still opening belongs to
    // connect(), which fails and cleans up.
    if (this.manualDisconnect || this.reconnecting || !this.established) {
      if (this.manualDisconnect) {
        this.dispose();
        this.status('disconnected', 'Disconnected');
        this.emit('disconnected', {});
      }
      return;
    }
    // Try to come back (the meter drops the link when it sleeps or loses range).
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS && !this.manualDisconnect; attempt++) {
        this.status('reconnecting', `Link lost - reconnecting (${attempt}/${RECONNECT_ATTEMPTS})`);
        try {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          if (this.manualDisconnect) break;
          await this.openSession();
          if (this.manualDisconnect) {
            // Disconnect was pressed while this attempt was opening the link.
            this.teardown();
            this.cancelPendingConnect();
            break;
          }
          this.startPolling(this.pollInterval);
          this.reconnecting = false;
          return;
        } catch (err) {
          this.log(`reconnect ${attempt} failed: ${err.message}`, 'warn');
          this.teardown();
          this.cancelPendingConnect();
        }
      }
    } finally {
      this.reconnecting = false;
    }
    this.dispose();
    this.status('disconnected', 'Meter disconnected - press its button to wake it, then connect again');
    this.emit('disconnected', {});
  }

  disconnect() {
    this.manualDisconnect = true;
    this.log('disconnect requested');
    if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.onGattDisconnected();
  }
}
