/** YA-36: the PurpleAir client asks for little, reads by field name, checks the key type, and never lets the key out. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createJsonLogger} from '../../../src/voice/alexa/log.ts';
import {
  createPurpleAirClient,
  KEY_CHECK_RETRY_MS,
  MAX_RESPONSE_BYTES,
  NAME_FIELDS,
  parseSensorsResponse,
  PurpleAirError,
  PURPLEAIR_KEYS_URL,
  PURPLEAIR_SENSORS_URL,
  READING_FIELDS,
  readCapped,
} from '../../../src/voice/air/purpleair.ts';
import {boxAround} from '../../../src/voice/air/geo.ts';
import {CANARY_KEY, fakeFetch, sensorsBody, type FetchCall} from './helpers.ts';

const BOX = boxAround({lat: 46.87, lon: -113.99}, 5);
const NOW = Date.parse('2026-09-14T12:00:00Z');
const READ_KEY_BODY = JSON.stringify({api_version: 'V1.0.15', time_stamp: 1757851200, api_key_type: 'READ'});

type Respond = (call: FetchCall) => {status: number; body?: string} | Promise<never>;

/** Answers the key check as READ unless `keyType` says otherwise, and everything else with `respond`. */
function client(respond: Respond, options: {key?: string; timeoutMs?: number; keyType?: string} = {}) {
  const lines: string[] = [];
  const log = createJsonLogger({level: 'debug', write: (line) => lines.push(line), now: () => NOW});
  const fetch = fakeFetch((call) => {
    if (call.url === PURPLEAIR_KEYS_URL) {
      return {
        status: 200,
        body: options.keyType === undefined ? READ_KEY_BODY : JSON.stringify({api_key_type: options.keyType}),
      };
    }
    return respond(call);
  });
  const purpleAir = createPurpleAirClient({
    readKey: async () => ('key' in options ? options.key : CANARY_KEY),
    fetch: fetch.fetch,
    log,
    now: () => NOW,
    ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
  });
  const sensorCalls = () => fetch.calls.filter((call) => call.url !== PURPLEAIR_KEYS_URL);
  return {purpleAir, calls: fetch.calls, sensorCalls, lines};
}

test('an area GET: outdoor, recent, the box, six reading fields (confidence included) and no name; the key in X-API-Key only', async () => {
  const c = client(() => ({status: 200, body: sensorsBody(['sensor_index', ...READING_FIELDS], [])}));
  await c.purpleAir.sensorsInBox(BOX, READING_FIELDS);
  const [call] = c.sensorCalls();
  const url = new URL(call.url);
  assert.equal(`${url.origin}${url.pathname}`, PURPLEAIR_SENSORS_URL);
  assert.equal(url.searchParams.get('location_type'), '0');
  assert.equal(url.searchParams.get('max_age'), '3600');
  assert.equal(url.searchParams.get('fields'), 'latitude,longitude,last_seen,humidity,pm2.5_10minute,confidence');
  assert.equal(Number(url.searchParams.get('nwlat')), Number(BOX.nwLat.toFixed(6)));
  assert.equal(Number(url.searchParams.get('selng')), Number(BOX.seLon.toFixed(6)));
  assert.equal(call.init.headers['X-API-Key'], CANARY_KEY);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.url.includes(CANARY_KEY), false, 'the key is never in the URL');
});

test('a name search asks for the name alone; the readings of chosen sensors come by show_only', async () => {
  const c = client((call) =>
    call.url.includes('show_only')
      ? {status: 200, body: sensorsBody(['sensor_index', ...READING_FIELDS], [[7, 46.9, -113.9, 1757851000, 30, 12]])}
      : {
          status: 200,
          body: sensorsBody(
            ['sensor_index', 'name'],
            [
              [7, 'Rattlesnake Creek'],
              [8, ''],
              ['x', 'Bad'],
            ],
          ),
        },
  );
  const names = await c.purpleAir.sensorsInBox(BOX, NAME_FIELDS);
  assert.deepEqual(names, [{index: 7, name: 'Rattlesnake Creek', lat: 0, lon: 0, lastSeenMs: 0}]);
  assert.equal(new URL(c.sensorCalls()[0].url).searchParams.get('fields'), 'name');
  const rows = await c.purpleAir.sensorsByIndex([7]);
  assert.equal(new URL(c.sensorCalls()[1].url).searchParams.get('show_only'), '7');
  assert.equal(rows[0].pm25TenMinute, 12);
});

test('an indoor name scan and sensor reading select location_type=1', async () => {
  const c = client(() => ({status: 200, body: sensorsBody(['sensor_index', ...READING_FIELDS], [])}));
  await c.purpleAir.sensorsInBox(BOX, NAME_FIELDS, undefined, 1);
  await c.purpleAir.sensorsByIndex([7], undefined, 1);
  assert.equal(new URL(c.sensorCalls()[0].url).searchParams.get('location_type'), '1');
  assert.equal(new URL(c.sensorCalls()[1].url).searchParams.get('location_type'), '1');
});

test('the key type is checked once per key: READ is used, WRITE (or anything else) refused before any data call', async () => {
  const read = client(() => ({status: 200, body: sensorsBody(['sensor_index', ...READING_FIELDS], [])}));
  await read.purpleAir.sensorsInBox(BOX, READING_FIELDS);
  await read.purpleAir.sensorsInBox(BOX, READING_FIELDS);
  assert.equal(read.calls.filter((call) => call.url === PURPLEAIR_KEYS_URL).length, 1);
  assert.equal(read.calls[0].init.headers['X-API-Key'], CANARY_KEY);

  const write = client(() => ({status: 200, body: sensorsBody([], [])}), {keyType: 'WRITE'});
  await assert.rejects(write.purpleAir.sensorsInBox(BOX, READING_FIELDS), /not-read-key/);
  assert.equal(write.sensorCalls().length, 0);
  const line = write.lines.map((entry) => JSON.parse(entry) as {event: string; level: string; keyType?: string});
  assert.deepEqual(
    line.filter((entry) => entry.event === 'air.purpleair.keyType').map((entry) => [entry.level, entry.keyType]),
    [['warn', 'WRITE']],
  );
  assert.equal(write.lines.join('\n').includes(CANARY_KEY), false);
});

test('rows are read by field name, whatever order PurpleAir sends them in; rows without a position are dropped', () => {
  const rows = parseSensorsResponse(
    sensorsBody(
      ['pm2.5_10minute', 'sensor_index', 'last_seen', 'longitude', 'humidity', 'latitude'],
      [
        [12.5, 131075, 1757851000, -113.99, 31, 46.87],
        [null, 131076, 1757851000, -113.98, null, 46.86],
        [3, 131077, 1757851000, null, 30, null],
      ],
    ),
  );
  assert.deepEqual(rows, [
    {name: '', lat: 46.87, lon: -113.99, lastSeenMs: 1757851000_000, index: 131075, humidity: 31, pm25TenMinute: 12.5},
    {name: '', lat: 46.86, lon: -113.98, lastSeenMs: 1757851000_000, index: 131076},
  ]);
  assert.throws(() => parseSensorsResponse('not json'), PurpleAirError);
  assert.throws(() => parseSensorsResponse('{"data": []}'), /malformed/);
});

test('HTTP failures become kinds: 403 key, 402 points, 429 rate, 5xx unavailable; the key is never logged', async () => {
  const cases: Array<[number, string]> = [
    [403, 'key-refused'],
    [402, 'points'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
  ];
  for (const [status, kind] of cases) {
    const c = client(() => ({status, body: `{"error":"x","description":"bad key ${CANARY_KEY}"}`}));
    await assert.rejects(c.purpleAir.sensorsInBox(BOX, READING_FIELDS), (error: unknown) => {
      assert.ok(error instanceof PurpleAirError);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes(CANARY_KEY), false);
      return true;
    });
    assert.equal(c.lines.join('\n').includes(CANARY_KEY), false, `the key was logged on HTTP ${status}`);
  }
});

test('no key stored: no request is made', async () => {
  const c = client(() => ({status: 200, body: sensorsBody([], [])}), {key: undefined});
  await assert.rejects(c.purpleAir.sensorsInBox(BOX, READING_FIELDS), /no-key/);
  assert.equal(c.calls.length, 0);
});

test('a body over the cap is refused: by its declared length, and by counting a stream that did not declare one', async () => {
  const big = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
  await assert.rejects(
    readCapped(
      {status: 200, text: async () => '', headers: {get: () => String(MAX_RESPONSE_BYTES + 1)}},
      MAX_RESPONSE_BYTES,
    ),
    /too-large/,
  );
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(64_000));
      if (pulled > 1000) controller.close();
    },
  });
  await assert.rejects(readCapped({status: 200, text: async () => '', body: stream}, MAX_RESPONSE_BYTES), /too-large/);
  assert.ok(pulled < 40, `stopped reading after ${pulled} chunks`);
  await assert.rejects(readCapped({status: 200, text: async () => big}, MAX_RESPONSE_BYTES), /too-large/);
  assert.equal(await readCapped({status: 200, text: async () => '{"ok":1}'}, MAX_RESPONSE_BYTES), '{"ok":1}');
  const c = client(() => ({status: 200, body: big}));
  await assert.rejects(c.purpleAir.sensorsInBox(BOX, READING_FIELDS), /too-large/);
});

test('a call that outlives its timeout is abandoned, even if the fetch ignores the signal', async () => {
  const c = client(() => new Promise<never>(() => {}), {timeoutMs: 5});
  await assert.rejects(c.purpleAir.sensorsInBox(BOX, READING_FIELDS), /unavailable/);
  const failed = c.lines.map((line) => JSON.parse(line) as {event: string; timedOut?: boolean});
  assert.equal(failed.find((line) => line.event === 'air.purpleair.failed')?.timedOut, true);
});

test("the turn's deadline aborts the call too", async () => {
  const c = client(() => new Promise<never>(() => {}));
  const turn = new AbortController();
  const pending = c.purpleAir.sensorsInBox(BOX, READING_FIELDS, turn.signal);
  turn.abort();
  await assert.rejects(pending, /unavailable/);
});

test('a failed key check is not retried for two minutes, and a warm-up and a question share one check', async () => {
  let now = NOW;
  let keyCalls = 0;
  const fetch = fakeFetch((call) => {
    if (call.url === PURPLEAIR_KEYS_URL) {
      keyCalls++;
      return keyCalls <= 1 ? {status: 503} : {status: 200, body: READ_KEY_BODY};
    }
    return {status: 200, body: sensorsBody(['sensor_index', ...READING_FIELDS], [])};
  });
  const purpleAir = createPurpleAirClient({
    readKey: async () => CANARY_KEY,
    fetch: fetch.fetch,
    log: () => {},
    now: () => now,
  });
  await assert.rejects(purpleAir.sensorsInBox(BOX, READING_FIELDS), /unavailable/);
  await assert.rejects(purpleAir.sensorsInBox(BOX, READING_FIELDS), /unavailable/);
  assert.equal(keyCalls, 1, 'the failure is remembered');
  now += KEY_CHECK_RETRY_MS;
  await Promise.all([purpleAir.warm?.(), purpleAir.sensorsInBox(BOX, READING_FIELDS)]);
  assert.equal(keyCalls, 2, 'retried once, shared by the warm-up and the question');
});
