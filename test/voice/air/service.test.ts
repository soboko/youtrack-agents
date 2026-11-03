/**
 * YA-36: the service over fake PurpleAir sensors and a fake geocoder. Widening and merging, the caches and their
 * freshness, location fallbacks, named lookups (sensor, near place, far place, a choice), spending limits, the turn
 * deadline, and failures that never reach the core as exceptions.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FakeGeocoder, FakePurpleAir, type AirFixture, type SensorFixture} from '../../../src/voice/air/fakes.ts';
import {distanceKm} from '../../../src/voice/air/geo.ts';
import {AirLimits, DEFAULT_AIR_LIMITS, type AirLimitSettings} from '../../../src/voice/air/limits.ts';
import {
  CACHE_TTL_MS,
  createAirQualityService,
  MAX_SENSORS,
  OPTIONAL_STEP_MS,
  parseHomeLocation,
} from '../../../src/voice/air/service.ts';
import type {AirQualityResult} from '../../../src/voice/core/types.ts';
import {recordingLog} from './helpers.ts';

const START = Date.parse('2026-09-14T12:00:00Z');
const MISSOULA = {lat: 46.8721, lon: -113.994};
const KM_PER_DEGREE = 111.195;

/** A sensor `km` north of Missoula. */
function north(km: number, name: string, extra: Partial<SensorFixture> = {}): SensorFixture {
  return {
    name,
    lat: MISSOULA.lat + km / KM_PER_DEGREE,
    lon: MISSOULA.lon,
    ageMinutes: 2,
    pm: 20,
    humidity: 40,
    ...extra,
  };
}

const PLACES: AirFixture['places'] = {
  missoula: [MISSOULA.lat, MISSOULA.lon],
  '59802': [46.905, -113.97],
  springfield: [
    {lat: 39.8, lon: -89.65, name: 'Springfield, Illinois'},
    {lat: 37.21, lon: -93.29, name: 'Springfield, Missouri'},
    {lat: 42.1, lon: -72.59, name: 'Springfield, Massachusetts', score: 0.6},
  ],
  'springfield, missouri': [{lat: 37.21, lon: -93.29, name: 'Springfield, Missouri'}],
  portland: [{lat: 45.52, lon: -122.68, name: 'Portland, Oregon'}],
  'rattlesnake creek': [{lat: 44.1, lon: -121.3, name: 'Rattlesnake Creek, Oregon', score: 0.9}],
  blorton: [{lat: 46.9, lon: -114.0, name: 'Blorton, Montana', score: 0.6}],
};

function setup(
  sensors: SensorFixture[],
  options: {
    home?: string;
    limits?: Partial<AirLimitSettings>;
    places?: AirFixture['places'];
    indoorSensorName?: string;
    indoorSensorIndex?: number;
  } = {},
) {
  let now = START;
  const clock = {now: () => now, advance: (ms: number) => (now += ms)};
  const purpleAir = new FakePurpleAir(sensors, START, clock.now);
  const geocoder = new FakeGeocoder(options.places ?? PLACES);
  const log = recordingLog();
  const parsed = parseHomeLocation(options.home);
  const service = createAirQualityService({
    purpleAir,
    geocoder,
    ...(parsed.home === undefined ? {} : {home: parsed.home}),
    ...(options.indoorSensorName === undefined ? {} : {indoorSensorName: options.indoorSensorName}),
    ...(options.indoorSensorIndex === undefined ? {} : {indoorSensorIndex: options.indoorSensorIndex}),
    limits: new AirLimits(clock.now, {...DEFAULT_AIR_LIMITS, ...options.limits}),
    now: clock.now,
    log: log.log,
  });
  return {service, purpleAir, geocoder, log, clock};
}

function reading(result: AirQualityResult) {
  assert.equal(result.kind, 'reading', JSON.stringify(result));
  return (result as Extract<AirQualityResult, {kind: 'reading'}>).reading;
}

const HOME = '46.8721,-113.994';

test('home uses the nearest valid outdoor sensor, after checking the widened ring for disagreement', async () => {
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c'), north(12, 'far')], {home: HOME});
  const here = await s.service.lookupHere(undefined);
  assert.equal(here.used, 'home');
  assert.equal(reading(here.result).sensors, 1);
  assert.equal(reading(here.result).radiusKm, 1);
  assert.equal(reading(here.result).distanceMetres, 1000);
  assert.equal(s.purpleAir.calls.length, 2);
  assert.equal(s.purpleAir.calls[0].fields?.includes('name'), false);
});

test('home skips a nearest sensor that wildly disagrees with two good sensors further out', async () => {
  const s = setup([north(0.11, 'near', {pm: 60}), north(11, 'far1', {pm: 5}), north(11.5, 'far2', {pm: 5})], {
    home: HOME,
  });
  const result = reading((await s.service.lookupHere(undefined)).result);
  assert.equal(s.purpleAir.calls.length, 2, 'widened once');
  assert.equal(result.category, 'good');
  assert.equal(result.sensors, 1);
  assert.equal(result.radiusKm, 11);
  assert.equal(result.fewSensors, false);
});

test('a failed widened check keeps the nearest valid reading and caches it', async () => {
  const s = setup([north(0.5, 'a'), north(1, 'b')], {home: HOME});
  const original = s.purpleAir.sensorsInBox.bind(s.purpleAir);
  let calls = 0;
  s.purpleAir.sensorsInBox = async (box, fields) => {
    calls++;
    if (calls === 2) throw new Error('timeout on widen');
    return original(box, fields);
  };
  const result = reading((await s.service.lookupHere(undefined)).result);
  assert.equal(result.sensors, 1);
  assert.equal(result.fewSensors, false);
  assert.equal(result.radiusKm, 1);
  await s.service.lookupHere(undefined);
  assert.equal(calls, 2, 'the known valid nearest answer is cached');
});

test('no sensors, and only stale sensors, are said as such after the widening', async () => {
  const empty = setup([], {home: HOME});
  assert.deepEqual((await empty.service.lookupHere(undefined)).result, {kind: 'noSensors', radiusKm: 15});
  const stale = setup([north(1, 'a', {ageMinutes: 30}), north(2, 'b', {ageMinutes: 50})], {home: HOME});
  assert.deepEqual((await stale.service.lookupHere(undefined)).result, {kind: 'stale', radiusKm: 15, ageMinutes: 30});
});

test('home chooses a sensor by true distance, never by a bounding-box corner', async () => {
  const eastKm = 4 / (KM_PER_DEGREE * Math.cos((MISSOULA.lat * Math.PI) / 180));
  const corner: SensorFixture = {...north(4, 'corner', {pm: 200}), lon: MISSOULA.lon + eastKm};
  assert.ok(distanceKm(MISSOULA, corner) > 5);
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c'), corner], {home: HOME});
  assert.equal(reading((await s.service.lookupHere(undefined)).result).sensors, 1);
  const many = setup(
    Array.from({length: MAX_SENSORS + 15}, (_unused, index) => north(index * 0.1, `s${index}`)),
    {home: HOME},
  );
  assert.equal(reading((await many.service.lookupHere(undefined)).result).sensors, 1);
});

test('review P2-5: a cached answer is aged when served, and past freshness it is fetched again, not called fresh', async () => {
  const s = setup(
    [1, 2, 3].map((km) => north(km, `s${km}`, {ageMinutes: 10})),
    {home: HOME},
  );
  assert.equal(reading((await s.service.lookupHere(undefined)).result).ageMinutes, 10);
  s.clock.advance(3 * 60_000);
  assert.equal(reading((await s.service.lookupHere(undefined)).result).ageMinutes, 13, 'the cache recomputes the age');
  assert.equal(s.purpleAir.calls.length, 2);
  s.clock.advance(3 * 60_000);
  assert.deepEqual((await s.service.lookupHere(undefined)).result, {kind: 'stale', radiusKm: 15, ageMinutes: 16});
  assert.equal(s.purpleAir.calls.length, 4, 'past 15 minutes the cached reading is not served; a new lookup widens');
});

test('the cache: the same rounded point within five minutes costs no call; after five minutes it does', async () => {
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c')], {home: '46.8712,-113.9921'});
  await s.service.lookupNamed('missoula', undefined);
  const callsAfterPlace = s.purpleAir.calls.length;
  await s.service.lookupHere(undefined);
  assert.equal(s.purpleAir.calls.length, callsAfterPlace + 2, 'home retains its distinct nearest-sensor cache');
  s.clock.advance(CACHE_TTL_MS);
  await s.service.lookupHere(undefined);
  assert.equal(s.purpleAir.calls.length, callsAfterPlace + 4);
});

test('failures are not cached, and a device postal code is geocoded once a day, not once a turn', async () => {
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c')]);
  const device = {countryCode: 'US', postalCode: '59802'};
  s.purpleAir.failNext('unavailable');
  assert.deepEqual(await s.service.lookupHere(device), {used: 'device', result: {kind: 'unavailable'}});
  assert.equal(reading((await s.service.lookupHere(device)).result).sensors, 1);
  await s.service.lookupHere(device);
  assert.equal(s.geocoder.calls.length, 1, 'the geocode is cached');
  assert.deepEqual(s.geocoder.calls[0], {text: '59802', countryCode: 'US'});
});

test('here: device first; not found, failing or absent, home; neither, no location; a failure names the one in use', async () => {
  const sensors = [north(1, 'a'), north(2, 'b'), north(3, 'c')];
  const device = {countryCode: 'US', postalCode: '59802'};
  assert.equal((await setup(sensors, {home: 'missoula'}).service.lookupHere(device)).used, 'device');
  assert.equal(
    (await setup(sensors, {home: 'missoula'}).service.lookupHere({countryCode: 'US', postalCode: '00000'})).used,
    'home',
  );
  const failing = setup(sensors, {home: HOME});
  failing.geocoder.failNext();
  assert.equal((await failing.service.lookupHere(device)).used, 'home');
  const absent = setup(sensors, {home: HOME});
  assert.equal((await absent.service.lookupHere(undefined)).used, 'home');
  assert.equal(absent.geocoder.calls.length, 0, 'a point home needs no geocoding');
  const nowhere = setup(sensors);
  assert.deepEqual(await nowhere.service.lookupHere(undefined), {used: 'none', result: {kind: 'noLocation'}});
  assert.equal(nowhere.purpleAir.calls.length, 0);
  const homeNotFound = setup(sensors, {home: 'Atlantis'});
  assert.deepEqual(await homeNotFound.service.lookupHere(undefined), {used: 'none', result: {kind: 'noLocation'}});
  // Review P3-15.
  const deviceFails = setup([]);
  deviceFails.purpleAir.failNext('unavailable');
  assert.deepEqual(await deviceFails.service.lookupHere(device), {used: 'device', result: {kind: 'unavailable'}});
});

test('review C3: "Springfield" far from the household is a choice; near one of them, that one; chosen, that one', async () => {
  const montana = setup([], {home: HOME});
  assert.deepEqual(await montana.service.lookupNamed('springfield', undefined), {
    matched: 'choice',
    places: ['Springfield, Missouri', 'Springfield, Illinois'],
  });
  assert.deepEqual(montana.geocoder.calls[0].bias, MISSOULA, 'the query is biased to home');
  assert.equal(montana.purpleAir.calls.filter((call) => call.indexes !== undefined).length, 0);

  const missouri = setup([], {home: '37.3,-93.2'});
  const near = await missouri.service.lookupNamed('springfield', undefined);
  assert.equal(near.matched, 'place');
  assert.equal(
    near.matched === 'place' && near.name,
    'Springfield, Missouri',
    'a near place whose name is shared is said with its state',
  );

  const chosen = await montana.service.lookupNamed('springfield, missouri', undefined, {chosen: true});
  assert.equal(chosen.matched, 'place');
  assert.equal(chosen.matched === 'place' && chosen.name, 'Springfield, Missouri');
});

test('review C3: "Rattlesnake Creek" is the nearby sensor, not a place of that name far away; a town is still the town', async () => {
  const sensors = [
    north(1, 'Downtown Missoula', {pm: 50}),
    north(2, 'Hip Strip'),
    north(3, 'Northside'),
    north(12, 'Rattlesnake Creek Upper', {pm: 6}),
    north(13, 'Rattlesnake Creek Lower', {pm: 6}),
  ];
  const s = setup(sensors, {home: HOME});
  const creek = await s.service.lookupNamed('rattlesnake creek', undefined);
  assert.equal(creek.matched, 'sensor');
  assert.equal(creek.matched === 'sensor' && reading(creek.result).sensors, 2);
  assert.equal(creek.matched === 'sensor' && reading(creek.result).category, 'good');
  const namesCall = s.purpleAir.calls.find((call) => call.fields?.join(',') === 'name');
  assert.ok(namesCall !== undefined, 'the name list asks for names only');

  const town = await s.service.lookupNamed('missoula', undefined);
  assert.equal(town.matched, 'place', '"Missoula" is the town, not the sensor called Downtown Missoula');

  const portland = await s.service.lookupNamed('portland', undefined);
  assert.equal(portland.matched, 'place');
  assert.equal(
    portland.matched === 'place' && portland.name,
    'Portland, Oregon',
    'a far place is said by its own name',
  );

  const weak = await s.service.lookupNamed('blorton', undefined);
  assert.equal(weak.matched === 'place' && weak.name, 'Blorton, Montana', 'a weak near match is said by its own name');

  assert.deepEqual(await s.service.lookupNamed('nowhere at all', undefined), {
    matched: 'none',
    result: {kind: 'notFound'},
  });
});

test('with no household point there is no sensor search and no bias, and a single place is said by its name', async () => {
  const s = setup([north(1, 'Rattlesnake Creek')]);
  const portland = await s.service.lookupNamed('portland', undefined);
  assert.equal(portland.matched === 'place' && portland.name, 'Portland, Oregon');
  assert.equal(s.geocoder.calls[0].bias, undefined);
  assert.equal(
    s.purpleAir.calls.some((call) => call.fields?.includes('name')),
    false,
  );
});

test('spending: 20 lookups per speaker and 40 in all per 10 minutes, then busy with no call made', async () => {
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c')], {home: HOME});
  for (let i = 0; i < 20; i++) await s.service.lookupHere(undefined, {speaker: 'alexa:user:A'});
  const calls = s.purpleAir.calls.length;
  assert.deepEqual(await s.service.lookupHere(undefined, {speaker: 'alexa:user:A'}), {
    used: 'none',
    result: {kind: 'busy'},
  });
  assert.equal(s.purpleAir.calls.length, calls);
  for (let i = 0; i < 20; i++) await s.service.lookupHere(undefined, {speaker: 'alexa:user:B'});
  assert.equal(
    (await s.service.lookupHere(undefined, {speaker: 'alexa:user:C'})).result.kind,
    'busy',
    'container limit',
  );
  s.clock.advance(10 * 60_000 + 1);
  assert.equal((await s.service.lookupHere(undefined, {speaker: 'alexa:user:A'})).result.kind, 'reading');
  assert.equal(s.log.text().includes('alexa:user:A'), false, 'the speaker key is never logged');
  assert.ok(s.log.records.some((record) => record.event === 'air.limit' && record.level === 'warn'));
});

test('spending: PurpleAir calls per hour and geocodes per day are capped, logged once, and each lookup emits metrics', async () => {
  const s = setup([north(1, 'a'), north(2, 'b'), north(3, 'c')], {
    home: HOME,
    limits: {purpleAirPerHour: 2, geocodesPerDay: 1, lookupsPerContainer: 100, lookupsPerSpeaker: 100},
  });
  for (const [index, place] of ['missoula', '59802'].entries()) {
    const found = await s.service.lookupNamed(place, undefined);
    if (index === 1) assert.deepEqual(found, {matched: 'none', result: {kind: 'busy'}}, 'second geocode refused');
  }
  const areas = setup([north(1, 'a'), north(2, 'b'), north(3, 'c')], {
    home: HOME,
    limits: {purpleAirPerHour: 1, lookupsPerContainer: 100, lookupsPerSpeaker: 100},
  });
  assert.equal((await areas.service.lookupHere(undefined)).result.kind, 'reading');
  areas.clock.advance(CACHE_TTL_MS);
  assert.equal((await areas.service.lookupHere(undefined)).result.kind, 'busy');
  assert.equal((await areas.service.lookupHere(undefined)).result.kind, 'busy');
  const exhausted = areas.log.records.filter((record) => record.event === 'air.budget.exhausted');
  assert.equal(exhausted.length, 1, 'logged once, not on every refusal');
  const usage = areas.log.records.filter((record) => record.event === 'air.usage');
  assert.equal(usage.length, 3);
  const emf = usage[0].fields._aws as {CloudWatchMetrics: Array<{Namespace: string; Metrics: Array<{Name: string}>}>};
  assert.equal(emf.CloudWatchMetrics[0].Namespace, 'YouTrackVoice/AirQuality');
  assert.deepEqual(
    emf.CloudWatchMetrics[0].Metrics.map((metric) => metric.Name),
    ['Lookups', 'PurpleAirCalls', 'GeocodeCalls'],
  );
  assert.equal(usage[0].fields.PurpleAirCalls, 1);
});

test('the deadline: with little time left, no widening and no sensor search', async () => {
  const s = setup([north(0.5, 'a'), north(1, 'Rattlesnake Creek')], {home: HOME});
  const deadline = START + OPTIONAL_STEP_MS - 1;
  const here = reading((await s.service.lookupHere(undefined, {deadline})).result);
  assert.equal(here.fewSensors, false);
  assert.equal(s.purpleAir.calls.length, 1, 'not widened');
  assert.deepEqual(await s.service.lookupNamed('rattlesnake creek', undefined, {deadline}), {
    matched: 'place',
    name: 'Rattlesnake Creek, Oregon',
    result: {kind: 'noSensors', radiusKm: 5},
  });
  assert.equal(
    s.purpleAir.calls.some((call) => call.fields?.includes('name')),
    false,
    'no name search',
  );
});

test('nothing it logs names a place, a postal code, a sensor or a coordinate', async () => {
  const s = setup([north(1, 'Downtown Missoula'), north(2, 'Hip Strip'), north(3, 'Northside')], {home: 'missoula'});
  await s.service.lookupHere({countryCode: 'US', postalCode: '59802'});
  await s.service.lookupNamed('missoula', undefined);
  await s.service.lookupNamed('hip strip', undefined);
  await s.service.lookupNamed('springfield', undefined);
  s.purpleAir.failNext('key-refused');
  s.clock.advance(CACHE_TTL_MS);
  await s.service.lookupNamed('missoula', undefined);
  const text = s.log.text().toLowerCase();
  for (const needle of ['missoula', '59802', 'hip strip', 'northside', 'springfield', 'illinois', '46.8', '113.9']) {
    assert.equal(text.includes(needle), false, `logged ${needle}`);
  }
});

test('review C1: HOME_LOCATION never throws: points, "lat lon", postal codes and names are read; the rest is invalid', () => {
  assert.deepEqual(parseHomeLocation(''), {});
  assert.deepEqual(parseHomeLocation(undefined), {});
  assert.deepEqual(parseHomeLocation(' 46.87 , -113.99 '), {home: {kind: 'point', point: {lat: 46.87, lon: -113.99}}});
  assert.deepEqual(parseHomeLocation('46.87 -113.99'), {home: {kind: 'point', point: {lat: 46.87, lon: -113.99}}});
  assert.deepEqual(parseHomeLocation('+46.87,-113.99'), {home: {kind: 'point', point: {lat: 46.87, lon: -113.99}}});
  assert.deepEqual(parseHomeLocation('59802'), {home: {kind: 'place', text: '59802'}});
  assert.deepEqual(parseHomeLocation('59802-1234'), {home: {kind: 'place', text: '59802-1234'}});
  assert.deepEqual(parseHomeLocation('Missoula 59802'), {home: {kind: 'place', text: 'Missoula 59802'}});
  assert.deepEqual(parseHomeLocation('Missoula, Montana'), {home: {kind: 'place', text: 'Missoula, Montana'}});
  assert.deepEqual(parseHomeLocation('46,-113'), {home: {kind: 'point', point: {lat: 46, lon: -113}}});
  assert.deepEqual(parseHomeLocation('46.87,-213.99'), {invalid: 'coordinates'});
  assert.deepEqual(parseHomeLocation('46.8,-1139'), {invalid: 'coordinates'});
  assert.deepEqual(parseHomeLocation('46.87'), {invalid: 'coordinates'});
  assert.deepEqual(parseHomeLocation('!!!'), {invalid: 'unreadable'});
  // Recheck N4: two bare numbers are coordinates, never a postal code; number words and exponents are unreadable.
  assert.deepEqual(parseHomeLocation('46 113'), {home: {kind: 'point', point: {lat: 46, lon: 113}}});
  assert.deepEqual(parseHomeLocation('91 0'), {invalid: 'coordinates'});
  assert.deepEqual(parseHomeLocation('59802 1234'), {invalid: 'coordinates'});
  for (const value of ['NaN,NaN', 'Infinity', '1e3,5', '46.8e1 -113']) {
    assert.deepEqual(parseHomeLocation(value), {invalid: 'unreadable'}, value);
  }
  assert.deepEqual(parseHomeLocation('SW1A 1AA'), {home: {kind: 'place', text: 'SW1A 1AA'}});
  assert.deepEqual(parseHomeLocation('x'.repeat(201)), {invalid: 'too-long'});
});

test('recheck N2: a same-named place under 300 km away in another state is said with its state; in the home state, not', async () => {
  const places: AirFixture['places'] = {
    ...PLACES,
    home: [{lat: MISSOULA.lat, lon: MISSOULA.lon, name: 'Missoula, Montana'}],
    'rattlesnake creek': [{lat: 45.5, lon: -115.9, name: 'Rattlesnake Creek, Idaho', score: 0.9}],
    lolo: [{lat: 46.76, lon: -114.08, name: 'Lolo, Montana'}],
  };
  const s = setup([], {home: 'home', places});
  const idaho = await s.service.lookupNamed('rattlesnake creek', undefined, {deadline: START + OPTIONAL_STEP_MS - 1});
  assert.ok(distanceKm(MISSOULA, {lat: 45.5, lon: -115.9}) < 300);
  assert.equal(idaho.matched === 'place' && idaho.name, 'Rattlesnake Creek, Idaho');
  const lolo = await s.service.lookupNamed('lolo', undefined);
  assert.equal(lolo.matched === 'place' && lolo.name, 'Lolo', 'the home region goes without saying');
  const pointHome = setup([], {home: HOME, places});
  const unknown = await pointHome.service.lookupNamed('lolo', undefined);
  assert.equal(
    unknown.matched === 'place' && unknown.name,
    'Lolo, Montana',
    'with no known home region, the state is said',
  );
});

test('explicit indoor sensor keeps the confidence caveat across cached reads and still rejects stale or invalid data', async () => {
  const sensor = north(0.2, 'indoor', {indoor: true, pm: 0, confidence: 30});
  const s = setup([sensor], {indoorSensorIndex: 1});
  for (let i = 0; i < 2; i++) {
    const value = reading(await s.service.lookupIndoor());
    assert.equal(value.aqi, 0);
    assert.equal(value.lowConfidence, true);
  }
  assert.equal(s.purpleAir.calls.length, 1);
  const stale = setup([{...sensor, ageMinutes: 20}], {indoorSensorIndex: 1});
  assert.equal((await stale.service.lookupIndoor()).kind, 'stale');
  const invalid = setup([{...sensor, pm: -1}], {indoorSensorIndex: 1});
  assert.equal((await invalid.service.lookupIndoor()).kind, 'noSensors');
  const outdoor = setup([{...sensor, indoor: false}], {home: HOME});
  assert.equal((await outdoor.service.lookupHere(undefined)).result.kind, 'noSensors');
});

test('indoor resolves its configured name once near home, then reads that indoor sensor by index', async () => {
  const indoor = north(0.2, 'Susans Cir, High Meadows, Park City A', {indoor: true, pm: 8});
  const s = setup([indoor, north(0.1, 'outdoor')], {home: HOME, indoorSensorName: indoor.name});
  const first = reading(await s.service.lookupIndoor());
  assert.equal(first.sensors, 1);
  assert.equal(s.purpleAir.calls.length, 2, 'one indoor-name scan and one index reading');
  const second = reading(await s.service.lookupIndoor());
  assert.equal(second.sensors, 1);
  assert.equal(s.purpleAir.calls.length, 2, 'the configured name and its fresh reading are cached');
});
