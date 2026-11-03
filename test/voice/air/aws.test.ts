/** YA-36: the Lambda wiring. Built on first use, the key read from one SSM parameter and never logged. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJsonLogger} from '../../../src/voice/alexa/log.ts';
import {
  AIR_SDK_CLIENT_CONFIG,
  airSettings,
  createLambdaAirQuality,
  KEY_CACHE_MS,
  PURPLEAIR_KEY_PARAMETER,
  ssmReadKey,
  type SsmGetParameterClient,
} from '../../../src/voice/air/aws.ts';
import type {GeoPlacesClient} from '../../../src/voice/air/geocoder.ts';
import {PURPLEAIR_KEYS_URL} from '../../../src/voice/air/purpleair.ts';
import {CANARY_KEY, fakeFetch, recordingLog, sensorsBody} from './helpers.ts';

const NOW = Date.parse('2026-09-14T12:00:00Z');

test('review C1: AIR_QUALITY and HOME_LOCATION never throw; off reads no home at all; a bad value is logged by kind', () => {
  const log = recordingLog();
  assert.deepEqual(airSettings({}, log.log), {enabled: false});
  assert.deepEqual(airSettings({AIR_QUALITY: 'on', HOME_LOCATION: '46.87,-113.99'}, log.log), {
    enabled: true,
    home: {kind: 'point', point: {lat: 46.87, lon: -113.99}},
  });
  assert.deepEqual(airSettings({AIR_QUALITY: 'off', HOME_LOCATION: '46.8,-1139'}, log.log), {enabled: false});
  assert.equal(log.records.length, 0, 'with air quality off, HOME_LOCATION is not even read');
  assert.deepEqual(airSettings({AIR_QUALITY: 'On'}, log.log), {enabled: false});
  assert.deepEqual(airSettings({AIR_QUALITY: 'on', HOME_LOCATION: '46.8,-1139'}, log.log), {enabled: true});
  assert.deepEqual(airSettings({AIR_QUALITY: 'on', HOME_LOCATION: '59802'}, log.log), {
    enabled: true,
    home: {kind: 'place', text: '59802'},
  });
  assert.deepEqual(
    log.records.map((record) => [record.level, record.event, record.fields.problem]),
    [
      ['warn', 'air.settings.invalid', undefined],
      ['warn', 'air.home.invalid', 'coordinates'],
    ],
  );
  assert.equal(log.text().includes('1139'), false, 'the value is never logged');
  assert.equal(
    createLambdaAirQuality({
      settings: {enabled: false},
      log: () => {},
      now: () => NOW,
      fetch: fakeFetch(() => ({status: 500})).fetch,
    }),
    undefined,
  );
});

test('the key: one decrypted GetParameter on the one name, cached for a while, a missing parameter is no key', async () => {
  const inputs: unknown[] = [];
  let now = NOW;
  let value: unknown = CANARY_KEY;
  const client: SsmGetParameterClient = {
    getParameter: async (input) => {
      inputs.push(input);
      if (value === 'missing') throw Object.assign(new Error('not found'), {name: 'ParameterNotFound'});
      if (value === 'denied')
        throw Object.assign(new Error(`denied for ${CANARY_KEY}`), {name: 'AccessDeniedException'});
      return {Parameter: {Value: value}};
    },
  };
  const lines: string[] = [];
  const log = createJsonLogger({level: 'debug', write: (line) => lines.push(line)});
  const read = ssmReadKey(
    async () => client,
    () => now,
    log,
  );
  assert.equal(await read(), CANARY_KEY);
  assert.equal(await read(), CANARY_KEY);
  assert.deepEqual(inputs, [{Name: PURPLEAIR_KEY_PARAMETER, WithDecryption: true}]);
  now += KEY_CACHE_MS;
  value = 'missing';
  assert.equal(await read(), undefined);
  now += KEY_CACHE_MS;
  value = 'denied';
  assert.equal(await read(), undefined);
  assert.equal(await read(), undefined);
  assert.equal(inputs.length, 4, 'a failed read is not cached');
  assert.equal(lines.join('\n').includes(CANARY_KEY), false);
});

test('built on the first question from the SDKs; a missing SDK costs only that answer, and is retried', async () => {
  const lines: string[] = [];
  const log = createJsonLogger({level: 'debug', write: (line) => lines.push(line), now: () => NOW});
  const configs: unknown[] = [];
  let geoLoads = 0;
  const places: GeoPlacesClient = {
    geocode: async () => ({
      ResultItems: [
        {
          PlaceType: 'Locality',
          Position: [-113.994, 46.8721],
          Address: {Locality: 'Missoula'},
          MatchScores: {Overall: 1},
        },
      ],
    }),
  };
  const fetch = fakeFetch((call) => {
    assert.equal(call.init.headers['X-API-Key'], CANARY_KEY);
    if (call.url === PURPLEAIR_KEYS_URL) return {status: 200, body: '{"api_key_type":"READ"}'};
    const seen = Math.floor(NOW / 1000) - 120;
    return {
      status: 200,
      body: sensorsBody(
        ['sensor_index', 'name', 'latitude', 'longitude', 'last_seen', 'humidity', 'pm2.5_10minute'],
        [
          [1, 'A', 46.872, -113.994, seen, 30, 25],
          [2, 'B', 46.873, -113.995, seen, 30, 24],
          [3, 'C', 46.871, -113.993, seen, 30, 26],
        ],
      ),
    };
  });
  const port = createLambdaAirQuality({
    settings: {enabled: true},
    log,
    now: () => NOW,
    fetch: fetch.fetch,
    loadSsmSdk: async () => ({
      SSM: class {
        constructor(config: unknown) {
          configs.push(config);
        }
        async getParameter() {
          return {Parameter: {Value: CANARY_KEY}};
        }
      },
    }),
    loadGeoPlacesSdk: async () => {
      geoLoads++;
      if (geoLoads === 1) return {};
      return {
        GeoPlaces: class {
          constructor(config: unknown) {
            configs.push(config);
          }
          geocode = places.geocode;
        },
      };
    },
  });
  assert.ok(port !== undefined);
  assert.equal(geoLoads, 0, 'nothing is loaded before the first question');
  assert.deepEqual(await port.lookupNamed('missoula', undefined), {matched: 'none', result: {kind: 'unavailable'}});
  const found = await port.lookupNamed('missoula', undefined);
  assert.equal(found.matched === 'place' && found.result.kind, 'reading');
  assert.equal(geoLoads, 2);
  assert.deepEqual(
    configs,
    [AIR_SDK_CLIENT_CONFIG, AIR_SDK_CLIENT_CONFIG],
    'the clients are made once, on the build that worked',
  );
  const written = lines.join('\n');
  assert.equal(written.includes(CANARY_KEY), false, 'the key is never logged, even at debug');
  assert.match(written, /air\.buildFailed/);
  assert.match(written, /air\.ready/);
});

test('the SSM read is cut by its own timeout and by the turn signal', async () => {
  const log = recordingLog();
  const read = ssmReadKey(
    async () => ({getParameter: () => new Promise<never>(() => {})}),
    () => NOW,
    log.log,
  );
  const turn = new AbortController();
  const pending = read(turn.signal);
  turn.abort();
  assert.equal(await pending, undefined);
  assert.ok(log.records.some((record) => record.event === 'air.key.readFailed'));
});
