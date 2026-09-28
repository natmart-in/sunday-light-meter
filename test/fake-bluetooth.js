// A small stand-in for Chrome's Web Bluetooth, enough to drive OppleMeter
// through connects, dropped links and retries. requestDevice hands back the
// same BluetoothDevice every time, as Chrome does within a page.

import { OPCODE, NUS_TX, NUS_RX, buildCommand, encapsulate } from '../src/protocol.js';

const LINK_UP_MS = 30;
const DISCOVERY_MS = 20;
const ANSWER_MS = 10;

const notConnected = () => Object.assign(new Error('GATT Server is disconnected. Cannot retrieve services. (Re)connect first with `device.gatt.connect`.'), { name: 'NetworkError' });

/** Answer a Light Master 4 command with calibration factors of 1 or a flat measurement. */
function answer(frame) {
  const opcode = (frame[3 + 9] << 8) | frame[3 + 10];
  const seq = frame[3 + 4];
  if (opcode === OPCODE.REQ_CAL) {
    const body = new Uint8Array(37);
    const view = new DataView(body.buffer);
    for (let i = 0; i < 9; i++) view.setFloat32(1 + 4 * i, 1, true);
    return encapsulate(buildCommand(OPCODE.RES_CAL, seq, body));
  }
  if (opcode === OPCODE.REQ_MEAS) {
    const body = new Uint8Array(23);
    for (let i = 0; i < 9; i++) body[2 + 2 * i] = 100;
    body[20] = 250; // 25.0 °C
    return encapsulate(buildCommand(OPCODE.RES_MEAS, seq, body));
  }
  return [];
}

/**
 * `dropAfter(n)` gives the ms after link n comes up at which the meter drops
 * it, or null to keep it. Returns handles to drive and inspect the meter.
 */
export function installFakeBluetooth({ dropAfter = () => null } = {}) {
  const meter = { links: 0, disconnectCalls: 0, drop: null };
  const device = new EventTarget();
  device.name = 'SigMesh';
  device.id = 'fake-lm4';
  const gatt = { connected: false, device };
  device.gatt = gatt;
  let up = false;
  let epoch = 0;
  let waiting = [];
  let dropTimer = null;

  const tx = Object.assign(new EventTarget(), { uuid: NUS_TX, properties: { notify: true, write: true, writeWithoutResponse: true } });
  const rx = Object.assign(new EventTarget(), { uuid: NUS_RX, properties: { write: true } });
  tx.startNotifications = async () => {
    if (!up) throw notConnected();
  };
  tx.writeValueWithoutResponse = async (frame) => {
    if (!up) throw notConnected();
    const at = epoch;
    const frames = answer(frame);
    setTimeout(() => {
      if (!up || at !== epoch) return;
      for (const f of frames) {
        tx.value = new DataView(f.buffer);
        tx.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }, ANSWER_MS);
  };

  function linkDown() {
    const was = up;
    up = false;
    gatt.connected = false;
    epoch += 1;
    clearTimeout(dropTimer);
    for (const w of waiting) w.reject(Object.assign(new Error('Connection attempt cancelled'), { name: 'AbortError' }));
    waiting = [];
    if (was) device.dispatchEvent(new Event('gattserverdisconnected'));
  }
  meter.drop = linkDown;
  meter.device = device;

  gatt.connect = () =>
    new Promise((resolve, reject) => {
      if (up) {
        gatt.connected = true;
        resolve(gatt);
        return;
      }
      waiting.push({ resolve, reject });
      if (waiting.length > 1) return;
      setTimeout(() => {
        if (!waiting.length) return;
        meter.links += 1;
        up = true;
        gatt.connected = true;
        const ms = dropAfter(meter.links);
        if (ms != null) dropTimer = setTimeout(linkDown, ms);
        const ws = waiting;
        waiting = [];
        for (const w of ws) w.resolve(gatt);
      }, LINK_UP_MS);
    });
  gatt.disconnect = () => {
    meter.disconnectCalls += 1;
    linkDown();
  };
  gatt.getPrimaryService = (uuid) => {
    if (!gatt.connected) return Promise.reject(notConnected());
    const at = epoch;
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!up || at !== epoch) reject(notConnected());
        else resolve({ uuid, getCharacteristic: async (u) => (u === NUS_TX ? tx : rx) });
      }, DISCOVERY_MS);
    });
  };

  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { bluetooth: { requestDevice: async () => device } } });
  return meter;
}
