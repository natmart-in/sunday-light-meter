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

/** Turn a raw measurement + calibration into the full processed reading. */
export function processMeasurement(meas, cal) {
  const kSensor = cal && cal.kSensor ? cal.kSensor : null;
  if (meas.model === 'lm4') {
    const { channels } = lm4Calibrate(meas.raw, kSensor || new Array(9).fill(1));
    const reading = lm4Process(channels);
    return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, battery: lm4Battery(meas.batteryRaw), temperature: meas.temperature ?? null, ts: Date.now() };
  }
  const { channels, c1 } = lm3Calibrate(meas.raw, kSensor || new Array(7).fill(1));
  const reading = lm3Process(channels, c1);
  return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, battery: lm3Battery(meas.batteryRaw), temperature: meas.temperature, ts: Date.now() };
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
    this.calibration = null;
    this.model = null;
    this.pollTimer = null;
    this.pollInterval = 500;
    this.inFlight = false;
    this.consecutiveTimeouts = 0;
    this.manualDisconnect = false;
    this.reconnecting = false;
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
      this.teardown();
      // Never leave a half-open link behind: it would keep the meter busy and
      // show up as "Paired"/connected in the next chooser.
      this.cancelPendingConnect();
      throw err;
    }
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

  teardown() {
    this.stopPolling();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Disconnected'));
      this.pending = null;
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
    if (this.manualDisconnect || this.reconnecting) {
      if (this.manualDisconnect) {
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
    this.cancelPendingConnect();
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
