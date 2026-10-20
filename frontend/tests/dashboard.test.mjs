import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/services/dashboardData.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { numeric, coordinates, recordingStatus, prepareDashboard, distanceKm, formatTractName, reconcileShelterAccessibility, parseDailyOperatingHours, parseWeeklyOperatingSchedule } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

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
test('tract and shelter records include headcounts alongside percentages and walkable counts', () => {
  const shelters = [
    {
      shelter_id: 10,
      shelter_name: 'Central High School',
      wheelchair_accessible: true,
      usage: 'EVAC',
      latitude: 26.0,
      longitude: -81.0,
      evacuation_capacity: 500,
      post_impact_capacity: 800,
      self_sufficient_electricity: true,
      pet_accommodations_code: 'Pets Allowed',
      address_1: '100 Main St',
      city: 'Fort Myers',
      zip: '33901',
    },
  ];
  const tracts = [
    {
      geo_id: '12071001401',
      lat: 26.004,
      lon: -81.004,
      total_pop: 4000,
      households: 1600,
      households_no_vehicle: 639,
      pct_no_vehicle: 39.9,
      pop_65_plus: 468,
      pct_age_65_plus: 11.7,
      pct_disability: 14.2,
      pct_mobility: 10.0,
      mobile_homes: 120,
      pct_mobile_homes: 7.5,
      group_quarters_pop: 45,
    },
  ];
  const hazards = [
    {
      geo_id: '12071001401',
      POPULATION: 4000,
      CFLD_EALP: 0,
      CFLD_EXPP: 3120,
      HRCN_EALP: 0,
      HRCN_EXPP: 4000,
    },
  ];
  const data = prepareDashboard(shelters, tracts, hazards, [], 'live');
  const tract = data.tracts[0];
  assert.equal(tract.totalPop, 4000);
  assert.equal(tract.households, 1600);
  assert.equal(tract.noVehicle, 639);
  assert.equal(tract.noVehicleShare, 39.9);
  assert.equal(tract.olderCount, 468);
  assert.equal(tract.olderShare, 11.7);
  assert.equal(tract.disabilityCount, 568);
  assert.equal(tract.disability, 14.2);
  assert.equal(tract.mobilityCount, 400);
  assert.equal(tract.mobilityShare, 10.0);
  assert.equal(tract.mobileHomes, 120);
  assert.equal(tract.mobileHomesShare, 7.5);
  assert.equal(tract.groupQuarters, 45);
  assert.equal(tract.coastalExposedPop, 3120);
  assert.equal(tract.coastalExposedShare, 78.0);
  assert.equal(tract.walkableEvacCount, 1);
  assert.equal(tract.walkableSeniorCount, 1);

  const shelter = data.shelters[0];
  assert.equal(shelter.postCapacity, 800);
  assert.equal(shelter.selfSufficientPower, 'YES');
  assert.equal(shelter.pets, 'Pets Allowed');
  assert.equal(shelter.nearbyNoVehicle5km, 639);
  assert.equal(shelter.siteCoastalFloodShare, 78.0);
  assert.equal(tract.nearCity, 'Fort Myers');
  assert.equal(tract.name, 'Census Tract 14.01 (near Fort Myers)');
  assert.equal(tract.label, 'Census Tract 14.01 (near Fort Myers) · 12071001401');
  assert.equal(formatTractName('12071001200', 'Cape Coral'), 'Census Tract 12 (near Cape Coral)');
});

test('shelter accessibility reconciliation covers match, conflict, and missing BigQuery record', () => {
  const matchYes = reconcileShelterAccessibility('YES', 'YES');
  assert.equal(matchYes.state, 'MATCH');
  assert.equal(matchYes.validationTrue, true);
  assert.equal(matchYes.resolvedAccess, 'YES');
  assert.equal(matchYes.resolvedSource, 'BigQuery');

  const conflict = reconcileShelterAccessibility('NO', 'YES');
  assert.equal(conflict.state, 'CONFLICT');
  assert.equal(conflict.validationTrue, false);
  assert.equal(conflict.resolvedAccess, 'YES');
  assert.equal(conflict.resolvedSource, 'Google Maps');

  const fromMaps = reconcileShelterAccessibility('UNRECORDED', 'YES');
  assert.equal(fromMaps.state, 'FROM_GOOGLE_MAPS');
  assert.equal(fromMaps.validationTrue, null);
  assert.equal(fromMaps.resolvedAccess, 'YES');
  assert.equal(fromMaps.resolvedSource, 'Google Maps');

  const fromBqOnly = reconcileShelterAccessibility('YES', 'UNLISTED');
  assert.equal(fromBqOnly.state, 'FROM_BIGQUERY_ONLY');
  assert.equal(fromBqOnly.resolvedAccess, 'YES');
  assert.equal(fromBqOnly.resolvedSource, 'BigQuery');

  const bothMissing = reconcileShelterAccessibility('UNRECORDED', 'UNLISTED');
  assert.equal(bothMissing.state, 'UNRECORDED');
  assert.equal(bothMissing.resolvedAccess, 'UNRECORDED');
  assert.equal(bothMissing.resolvedSource, 'Unrecorded');
});

test('parseDailyOperatingHours parses 24h, closed, unlisted, and time ranges into 24-hr histogram blocks', () => {
  const roundTheClock = parseDailyOperatingHours('Open 24 hours');
  assert.equal(roundTheClock.is24Hours, true);
  assert.equal(roundTheClock.openBlocks.every(Boolean), true);

  const closed = parseDailyOperatingHours('Permanently closed');
  assert.equal(closed.isClosed, true);
  assert.equal(closed.openBlocks.some(Boolean), false);

  const unlisted = parseDailyOperatingHours('Not listed on Google Maps');
  assert.equal(unlisted.unlisted, true);

  const standardDay = parseDailyOperatingHours('Mon-Fri 7:30 AM - 4:00 PM');
  assert.equal(standardDay.is24Hours, false);
  assert.equal(standardDay.openBlocks[6], false);
  assert.equal(standardDay.openBlocks[7], true);
  assert.equal(standardDay.openBlocks[15], true);
  assert.equal(standardDay.openBlocks[16], false);

  const eveningShift = parseDailyOperatingHours('8:00 PM - 2:00 AM');
  assert.equal(eveningShift.openBlocks[20], true);
  assert.equal(eveningShift.openBlocks[23], true);
  assert.equal(eveningShift.openBlocks[0], true);
  assert.equal(eveningShift.openBlocks[1], true);
  assert.equal(eveningShift.openBlocks[2], false);
});

test('parseWeeklyOperatingSchedule parses 7 days Sun-Sat, Y axis hours, closed days, and per-day schedules', () => {
  const weekly = parseWeeklyOperatingSchedule('Monday: 8:00 AM – 5:00 PM, Tuesday: 8:00 AM – 5:00 PM, Wednesday: 8:00 AM – 5:00 PM, Thursday: 8:00 AM – 5:00 PM, Friday: 8:00 AM – 5:00 PM, Saturday: Closed, Sunday: Closed');
  assert.equal(weekly.days.length, 7);
  assert.equal(weekly.days[0].day, 'Sun');
  assert.equal(weekly.days[0].isClosed, true);
  assert.equal(weekly.days[1].day, 'Mon');
  assert.equal(weekly.days[1].isOpen, true);
  assert.equal(weekly.days[1].startHour, 8);
  assert.equal(weekly.days[1].endHour, 17);
  assert.equal(weekly.days[5].day, 'Fri');
  assert.equal(weekly.days[5].isOpen, true);
  assert.equal(weekly.days[6].day, 'Sat');
  assert.equal(weekly.days[6].isClosed, true);
  assert.equal(weekly.yMinHour, 8);
  assert.equal(weekly.yMaxHour, 20);

  const rangeSched = parseWeeklyOperatingSchedule('Mon-Fri 7:30 AM - 4:00 PM');
  assert.equal(rangeSched.days[0].isClosed, true); // Sun
  assert.equal(rangeSched.days[1].isOpen, true); // Mon
  assert.equal(rangeSched.days[1].startHour, 7.5);
  assert.equal(rangeSched.days[1].endHour, 16);
  assert.equal(rangeSched.days[6].isClosed, true); // Sat

  const roundClock = parseWeeklyOperatingSchedule('Open 24 hours');
  assert.equal(roundClock.isAll24Hours, true);
  assert.equal(roundClock.days.every(d => d.is24Hours), true);

  const closed = parseWeeklyOperatingSchedule('Permanently closed');
  assert.equal(closed.isAllClosed, true);
  assert.equal(closed.days.every(d => d.isClosed), true);
});
