import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REQUEST_OPTIONS, REQUEST_OPTIONS_ALL } from '../src/meter.js';
import { NUS_SERVICE } from '../src/protocol.js';

// Advertised names seen on real meters (neither advertises the UART service UUID).
const ADVERTISED = ['SigMesh', 'LightMaster'];

test('chooser filters match every known Light Master advertising name', () => {
  const prefixes = REQUEST_OPTIONS.filters.filter((f) => f.namePrefix).map((f) => f.namePrefix);
  for (const name of ADVERTISED) assert.ok(prefixes.some((p) => name.startsWith(p)), `${name} not matched by ${prefixes}`);
  assert.ok(REQUEST_OPTIONS.filters.some((f) => f.services && f.services.includes(NUS_SERVICE)));
  assert.ok(REQUEST_OPTIONS.optionalServices.includes(NUS_SERVICE));
  assert.equal(REQUEST_OPTIONS_ALL.acceptAllDevices, true);
  assert.ok(REQUEST_OPTIONS_ALL.optionalServices.includes(NUS_SERVICE));
});
