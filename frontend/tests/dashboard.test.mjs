import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/services/dashboardData.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { numeric, coordinates, recordingStatus, prepareDashboard, distanceKm } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

test('unknown measurements and boolean flags never become zero or NO', () => {
  for (const value of [null, undefined, '', '  ', true, false, NaN, Infinity]) assert.equal(numeric(value), null);
  assert.equal(numeric(0), 0);
  assert.equal(recordingStatus(null), 'UNRECORDED');
  assert.equal(recordingStatus(false), 'NO');
  assert.equal(recordingStatus(true), 'YES');
  assert.equal(coordinates(null, -81), null);
  assert.equal(coordinates(91, -81), null);
});
test('county power suppression does not expose 11 as an actual count', () => {
  const data = prepareDashboard([], [], [], [{ power_dependent_dme: 11, power_dependent_is_censored: true }], 'live');
  assert.equal(data.power, null);
  assert.equal(data.powerCensored, true);
  assert.equal(data.capacity, null);
});
test('ranking uses household counts and distances exclude POST or unknown accessibility', () => {
  const shelters = [
    { shelter_id: 1, wheelchair_accessible: true, usage: 'EVAC', latitude: 26, longitude: -81, evacuation_capacity: 0 },
    { shelter_id: 2, wheelchair_accessible: true, usage: 'POST', latitude: 26, longitude: -81.1 },
    { shelter_id: 3, wheelchair_accessible: null, usage: 'EVAC', latitude: 26, longitude: -81.1 },
  ];
  const tracts = [
    { geo_id: 'low', lat: 26, lon: -81.1, households_no_vehicle: 5 },
    { geo_id: 'high', lat: 26, lon: -81.1, households_no_vehicle: 500 },
    { geo_id: 'unknown', households_no_vehicle: null },
  ];
  const data = prepareDashboard(shelters, tracts, [{ geo_id: 'high', HRCN_EALP: 0 }], [], 'live');
  assert.deepEqual(data.tracts.map(t => t.id), ['high', 'low', 'unknown']);
  assert.ok(data.tracts[0].nearestAccessible > 9);
  assert.equal(data.tracts[0].hurricaneLoss, 0);
  assert.equal(data.tracts[1].hurricaneLoss, null);
  assert.equal(data.tracts[2].nearestAccessible, null);
  assert.equal(data.capacity, 0);
  assert.equal(data.capacityMissing, 2);
  assert.deepEqual(data.access, { YES: 2, NO: 0, UNRECORDED: 1 });
  assert.equal(data.shelters[0].id, '1');
  assert.equal(data.shelters[0].surge, 'UNRECORDED');
});
test('missing eligible sites remain unknown rather than a zero-distance site', () => {
  const data = prepareDashboard([], [{ geo_id: 't', lat: 26, lon: -81 }], [], [], 'preview');
  assert.equal(data.tracts[0].nearestAccessible, null);
  assert.equal(data.source, 'preview');
  assert.ok(data.warnings.some(w => w.includes('hazard')));
  assert.equal(distanceKm([26, -81], [26, -81]), 0);
});
