// Web Bluetooth session with an Opple Light Master 3 or 4.
//
// Usage:
//   const meter = new OppleMeter();
//   meter.addEventListener('reading', (e) => console.log(e.detail));
//   await meter.connect();      // must be called from a user gesture
//   meter.startPolling(500);
//
// Events: 'status' {state, message}, 'reading' (processed measurement),
// 'battery' {percent, mv}, 'disconnected'.

import { NUS_SERVICE, NUS_TX, NUS_RX, OPCODE, buildCommand, encapsulate, MessageAssembler, opcodeOf, parseMeasurement, parseCalibration } from './protocol.js';
import { lm3Process, lm3Calibrate, lm3Battery } from './lm3.js';
import { lm4Process, lm4Calibrate, lm4Battery } from './lm4.js';

export const REQUEST_OPTIONS = {
  filters: [
    { services: [NUS_SERVICE] },
    { namePrefix: 'SigMesh' }, // Light Master 4 advertises as "SigMesh"
    { namePrefix: 'Opple' },
    { namePrefix: 'LMaster' },
    { namePrefix: 'Light Master' },
  ],
  optionalServices: [NUS_SERVICE, 'battery_service'],
};

export function bluetoothSupport() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) {
    return { ok: false, reason: 'no-api' };
  }
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, reason: 'insecure' };
  }
  return { ok: true };
}

/** Turn a raw measurement + calibration into the full processed reading. */
export function processMeasurement(meas, cal) {
  const kSensor = cal && cal.kSensor ? cal.kSensor : null;
  if (meas.model === 'lm4') {
    const { channels } = lm4Calibrate(meas.raw, kSensor || new Array(9).fill(1));
    const reading = lm4Process(channels);
    return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, battery: lm4Battery(meas.batteryRaw), temperature: null, ts: Date.now() };
  }
  const { channels, c1 } = lm3Calibrate(meas.raw, kSensor || new Array(7).fill(1));
  const reading = lm3Process(channels, c1);
  return { ...reading, raw: meas.raw, kSensor, calibrated: !!kSensor, battery: lm3Battery(meas.batteryRaw), temperature: meas.temperature, ts: Date.now() };
}

export class OppleMeter extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.seq = 0;
    this.assembler = new MessageAssembler();
    this.pending = null; // { opcode, resolve, reject, timer }
    this.calibration = null;
    this.model = null;
    this.pollTimer = null;
    this.pollInterval = 500;
    this.inFlight = false;
    this.manualDisconnect = false;
    this.onNotify = this.onNotify.bind(this);
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  get connected() {
    return !!(this.server && this.server.connected && this.writeChar);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  status(state, message) {
    this.emit('status', { state, message });
  }

  /** Prompt for a meter and open the session. Must run inside a user gesture. */
  async connect() {
    const support = bluetoothSupport();
    if (!support.ok) throw new Error(support.reason === 'insecure' ? 'Web Bluetooth needs an https page' : 'This browser has no Web Bluetooth (use Chrome or Edge)');
    this.status('requesting', 'Choose your Light Master in the browser dialog');
    const device = await navigator.bluetooth.requestDevice(REQUEST_OPTIONS);
    this.device = device;
    this.manualDisconnect = false;
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    await this.openSession();
    return this.info();
  }

  async openSession() {
    const name = this.device.name || 'Light Master';
    this.status('connecting', `Connecting to ${name}`);
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(NUS_SERVICE);
    const tx = await service.getCharacteristic(NUS_TX);
    let rx = null;
    try {
      rx = await service.getCharacteristic(NUS_RX);
    } catch (_) {
      rx = null;
    }
    // Opple meters take commands on the notify characteristic; fall back to classic NUS RX.
    if (tx.properties.write || tx.properties.writeWithoutResponse) this.writeChar = tx;
    else if (rx) this.writeChar = rx;
    else throw new Error('No writable characteristic on this device');
    this.notifyChar = tx;
    this.assembler.reset();
    tx.addEventListener('characteristicvaluechanged', this.onNotify);
    await tx.startNotifications();

    this.status('calibrating', 'Reading sensor calibration');
    this.calibration = await this.readCalibration();
    if (this.calibration) this.model = this.calibration.model;
    // A first measurement settles the model detection (the payload length is authoritative).
    const first = await this.measureRaw(4000);
    this.model = first.model;
    if (this.calibration && this.calibration.model !== first.model) {
      // Mismatched calibration length - trust the measurement and truncate/pad.
      const need = first.model === 'lm4' ? 9 : 7;
      const k = this.calibration.kSensor.slice(0, need);
      while (k.length < need) k.push(1);
      this.calibration = { model: first.model, kSensor: k };
    }
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
        const msg = await this.command(OPCODE.REQ_CAL, OPCODE.RES_CAL, 3000);
        const cal = parseCalibration(msg);
        if (cal) return cal;
      } catch (_) {
        // retry once
      }
    }
    return null;
  }

  async measureRaw(timeout = 3000) {
    const msg = await this.command(OPCODE.REQ_MEAS, OPCODE.RES_MEAS, timeout);
    const meas = parseMeasurement(msg);
    if (!meas) throw new Error('Unparseable measurement');
    return meas;
  }

  /** One calibrated, processed reading. */
  async measure(timeout = 3000) {
    const meas = await this.measureRaw(timeout);
    return processMeasurement(meas, this.calibration);
  }

  command(opcode, responseOpcode, timeout = 3000, body = new Uint8Array(0)) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    if (this.pending) return Promise.reject(new Error('Command already in flight'));
    this.seq = (this.seq + 1) & 0xff;
    const frames = encapsulate(buildCommand(opcode, this.seq, body));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('Meter did not answer (is it awake?)'));
      }, timeout);
      this.pending = { opcode: responseOpcode, resolve, reject, timer };
      this.writeFrames(frames).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(err);
      });
    });
  }

  async writeFrames(frames) {
    for (const f of frames) {
      if (this.writeChar.properties.writeWithoutResponse) await this.writeChar.writeValueWithoutResponse(f);
      else await this.writeChar.writeValue(f);
    }
  }

  onNotify(event) {
    const dv = event.target.value;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const msg = this.assembler.feed(bytes);
    if (!msg) return;
    const code = opcodeOf(msg);
    if (this.pending && code === this.pending.opcode) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(msg);
    }
    // Unsolicited frames (opcode 0 heartbeats etc.) are ignored.
  }

  startPolling(intervalMs = 500) {
    this.pollInterval = intervalMs;
    this.stopPolling();
    const tick = async () => {
      if (!this.connected) return;
      if (!this.inFlight) {
        this.inFlight = true;
        try {
          const reading = await this.measure(3000);
          this.emit('reading', reading);
        } catch (err) {
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

  async onGattDisconnected() {
    this.stopPolling();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Disconnected'));
      this.pending = null;
    }
    this.writeChar = null;
    if (this.manualDisconnect) {
      this.status('disconnected', 'Disconnected');
      this.emit('disconnected', {});
      return;
    }
    // Try to come back (the meter drops the link when it sleeps).
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.status('reconnecting', `Link lost - reconnecting (${attempt}/3)`);
      try {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        await this.openSession();
        this.startPolling(this.pollInterval);
        return;
      } catch (_) {
        // keep trying
      }
    }
    this.status('disconnected', 'Meter disconnected - press its button to wake it, then connect again');
    this.emit('disconnected', {});
  }

  disconnect() {
    this.manualDisconnect = true;
    this.stopPolling();
    if (this.notifyChar) {
      try {
        this.notifyChar.removeEventListener('characteristicvaluechanged', this.onNotify);
      } catch (_) {
        // ignore
      }
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.onGattDisconnected();
  }
}
