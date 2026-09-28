import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OppleMeter } from '../src/meter.js';
import { installFakeBluetooth } from './fake-bluetooth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rory, 28 Sep 2026: the meter dropped its link during service discovery, and
// every retry in the same tab then failed the same way. The failed session was
// still listening on the shared device and ran its auto-reconnect behind the
// page's back, grabbing the meter and cancelling the next attempt.
test('a failed connect leaves nothing running on the meter', async () => {
  const fake = installFakeBluetooth({ dropAfter: (n) => (n === 1 ? 5 : null) });
  const first = new OppleMeter();
  await assert.rejects(first.connect(), /GATT Server is disconnected/);
  await sleep(1200); // past the first auto-reconnect delay
  assert.equal(fake.links, 1, 'the failed session reopened the link');
  assert.equal(fake.device.gatt.connected, false);

  const second = new OppleMeter();
  await second.connect();
  assert.equal(second.connected, true);
  assert.equal(second.modelName(), 'Light Master 4');
  second.disconnect();
});

test('Disconnect releases the meter and nothing takes it back', async () => {
  const fake = installFakeBluetooth({ dropAfter: (n) => (n === 1 ? 5 : null) });
  await assert.rejects(new OppleMeter().connect());
  const meter = new OppleMeter();
  await meter.connect();
  meter.disconnect();
  await sleep(1200);
  assert.equal(fake.device.gatt.connected, false, 'something reconnected after Disconnect');
  assert.equal(fake.links, 2);
});

test('a live session still reconnects by itself after a dropped link', async () => {
  const fake = installFakeBluetooth();
  const meter = new OppleMeter();
  await meter.connect();
  meter.startPolling(200);
  fake.drop();
  await sleep(1200);
  assert.equal(meter.connected, true);
  assert.equal(fake.links, 2);
  meter.disconnect();
});
