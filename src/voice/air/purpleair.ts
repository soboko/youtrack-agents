/**
 * A PurpleAir API v1 client for the calls the voice client makes (YA-36): outdoor sensors in a bounding box, the same
 * for a few sensors by index, and a once-per-key check that the key is a READ key.
 *
 * `GET https://api.purpleair.com/v1/sensors` with the key in the `X-API-Key` header, `location_type=0` (outside), a
 * `max_age` in seconds, and either the box as `nwlng`/`nwlat`/`selng`/`selat` or `show_only` (a list of
 * `sensor_index` values), and only the fields used. PurpleAir charges API points per request and per field per row
 * returned, and has no parameter that caps the rows, so the box is what bounds the cost: an area fetch asks for five
 * fields and no name; a name search asks for the name alone, then the readings of at most a few sensors by index. The
 * response carries `fields` and `data` (rows in that order, "order may change"), so values are read by name. Key
 * errors are 403, an exhausted point balance 402, rate limiting 429 (api.purpleair.com, doc version 1.0.15, checked
 * 2026-09-14).
 *
 * `GET https://api.purpleair.com/v1/keys` "Checks the validity and returns the key type" (`api_key_type`: READ, WRITE,
 * READ_DISABLED, ...). It is called once per distinct key; anything but READ is refused and logged at warn, so a WRITE
 * key pasted by mistake is never used (review P3). Its point cost is not documented [UNVERIFIED].
 *
 * The key never leaves this module except in that header: it is not in a URL, an error, or a log field. Every call has
 * its own timeout, joined with the turn's deadline, redirects are refused so the header cannot travel elsewhere, and
 * a response body over `MAX_RESPONSE_BYTES` is refused (review P3: an unbounded body could exhaust the function).
 */
import type {VoiceLogger} from '../core/types.ts';
import type {BoundingBox} from './geo.ts';
import type {SpendKind} from './limits.ts';

export const PURPLEAIR_API = 'https://api.purpleair.com/v1';
export const PURPLEAIR_SENSORS_URL = `${PURPLEAIR_API}/sensors`;
export const PURPLEAIR_KEYS_URL = `${PURPLEAIR_API}/keys`;

/**
 * The fields for a reading. `sensor_index` comes back with every row whether asked for or not. `confidence` is "The
 * average of confidence_manual and confidence_auto. A value between 0 and 100 (%)", each "indicating how closely
 * channel A and B pseudo averages match each other" (api_data.js, doc 1.0.15; recheck N1): one field more per row.
 */
export const READING_FIELDS = [
  'latitude',
  'longitude',
  'last_seen',
  'humidity',
  'pm2.5_10minute',
  'confidence',
] as const;
/** The field for a name search: the name alone, one field per row. */
export const NAME_FIELDS = ['name'] as const;

/** Readings older than this are not returned at all (seconds). Fresher-than-that is decided by the aggregation. */
export const MAX_AGE_SECONDS = 3600;

/** The longest one PurpleAir call may take, inside Alexa's answer budget. */
export const PURPLEAIR_TIMEOUT_MS = 2000;
/** The most of a response body read. A 15 km box in a dense city is a few hundred kilobytes. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** One outdoor sensor's row, as used. Never spoken or logged: the name feeds the name search, the index a re-fetch. */
export interface SensorRow {
  /** PurpleAir's `sensor_index`, kept in memory only for a `show_only` fetch. */
  index?: number;
  name: string;
  lat: number;
  lon: number;
  /** Epoch milliseconds; 0 when not asked for. */
  lastSeenMs: number;
  /** Percent; undefined when the sensor reports none. */
  humidity?: number;
  /** µg/m³, the 10-minute cf_atm average for an outdoor sensor; undefined when absent. */
  pm25TenMinute?: number;
  /** PurpleAir's channel-agreement confidence, 0 to 100; undefined when absent. */
  confidence?: number;
}

export type PurpleAirFailureKind =
  | 'no-key'
  | 'not-read-key'
  | 'key-refused'
  | 'points'
  | 'rate-limited'
  | 'budget'
  | 'too-large'
  | 'unavailable'
  | 'malformed';

/** A failed PurpleAir call. The message names the kind and status only, never the key or the response body. */
export class PurpleAirError extends Error {
  readonly kind: PurpleAirFailureKind;
  readonly status?: number;

  constructor(kind: PurpleAirFailureKind, status?: number) {
    super(status === undefined ? `PurpleAir: ${kind}` : `PurpleAir: ${kind} (HTTP ${status})`);
    this.name = 'PurpleAirError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface AirFetchInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'error';
  signal: AbortSignal;
}

export interface AirFetchResponse {
  status: number;
  text(): Promise<string>;
  headers?: {get(name: string): string | null};
  body?: ReadableStream<Uint8Array> | null;
}

/** The part of `fetch` the air service uses. The global `fetch` satisfies it. */
export type AirFetch = (url: string, init: AirFetchInit) => Promise<AirFetchResponse>;

export interface PurpleAirClientOptions {
  /** The read key, from SSM. `undefined` means it is not stored. Called per request; the caller may cache it. */
  readKey: (signal?: AbortSignal) => Promise<string | undefined>;
  fetch: AirFetch;
  log: VoiceLogger;
  now: () => number;
  timeoutMs?: number;
  /** Takes one call from the spending budget, or names the budget used up. Not called for the key check. */
  takeBudget?: () => SpendKind | null;
}

/** A failed key check (an error or a refusal, not a WRITE verdict) is not retried for this long. */
export const KEY_CHECK_RETRY_MS = 2 * 60 * 1000;

export interface PurpleAirClient {
  /** Reads the key and checks its type now, so the first question does not wait for it (recheck N6). Never throws. */
  warm?(): Promise<void>;
  /** Sensors of the selected location type in the box that reported within `MAX_AGE_SECONDS`. */
  sensorsInBox(
    box: BoundingBox,
    fields: readonly string[],
    signal?: AbortSignal,
    locationType?: 0 | 1,
  ): Promise<SensorRow[]>;
  /** The given sensors (at most a few), with reading fields. */
  sensorsByIndex(indexes: readonly number[], signal?: AbortSignal, locationType?: 0 | 1): Promise<SensorRow[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The query string for a box. Coordinates go to six decimal places (about 0.1 m). */
export function sensorsQuery(box: BoundingBox, fields: readonly string[] = READING_FIELDS, locationType = 0): string {
  const params = new URLSearchParams({
    fields: fields.join(','),
    location_type: String(locationType),
    max_age: String(MAX_AGE_SECONDS),
    nwlng: box.nwLon.toFixed(6),
    nwlat: box.nwLat.toFixed(6),
    selng: box.seLon.toFixed(6),
    selat: box.seLat.toFixed(6),
  });
  return params.toString();
}

/** The query string for a few sensors by index, with reading fields. */
export function indexQuery(indexes: readonly number[], locationType = 0): string {
  return new URLSearchParams({
    fields: READING_FIELDS.join(','),
    location_type: String(locationType),
    max_age: String(MAX_AGE_SECONDS),
    show_only: indexes.map((index) => String(Math.trunc(index))).join(','),
  }).toString();
}

/**
 * Rows from a response body, read by field name. A reading row without a position or a time is dropped; a name row
 * needs only its name and index.
 */
export function parseSensorsResponse(body: string): SensorRow[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new PurpleAirError('malformed');
  }
  if (!isRecord(json) || !Array.isArray(json.fields) || !Array.isArray(json.data)) {
    throw new PurpleAirError('malformed');
  }
  const index = new Map<string, number>();
  json.fields.forEach((field, position) => {
    if (typeof field === 'string') index.set(field, position);
  });
  const at = (row: unknown[], field: string): unknown => {
    const position = index.get(field);
    return position === undefined ? undefined : row[position];
  };
  const namesOnly = !index.has('latitude') && index.has('name');
  const rows: SensorRow[] = [];
  for (const raw of json.data) {
    if (!Array.isArray(raw)) continue;
    const sensorIndex = finite(at(raw, 'sensor_index'));
    const name = at(raw, 'name');
    if (namesOnly) {
      if (sensorIndex === undefined || typeof name !== 'string' || name.trim() === '') continue;
      rows.push({index: sensorIndex, name, lat: 0, lon: 0, lastSeenMs: 0});
      continue;
    }
    const lat = finite(at(raw, 'latitude'));
    const lon = finite(at(raw, 'longitude'));
    const lastSeen = finite(at(raw, 'last_seen'));
    if (lat === undefined || lon === undefined || lastSeen === undefined) continue;
    const row: SensorRow = {name: typeof name === 'string' ? name : '', lat, lon, lastSeenMs: lastSeen * 1000};
    if (sensorIndex !== undefined) row.index = sensorIndex;
    const humidity = finite(at(raw, 'humidity'));
    if (humidity !== undefined) row.humidity = humidity;
    const confidence = finite(at(raw, 'confidence'));
    if (confidence !== undefined) row.confidence = confidence;
    const pm25 = finite(at(raw, 'pm2.5_10minute'));
    if (pm25 !== undefined) row.pm25TenMinute = pm25;
    rows.push(row);
  }
  return rows;
}

/** Settles with `promise`, or rejects with an AbortError once `signal` fires, even if the promise ignores it. */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** A response body as text, refusing more than `maxBytes` whether or not the server said how long it is. */
export async function readCapped(response: AirFetchResponse, maxBytes: number): Promise<string> {
  const declared = Number(response.headers?.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new PurpleAirError('too-large');
  const stream = response.body;
  if (stream === undefined || stream === null) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new PurpleAirError('too-large');
    return text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PurpleAirError('too-large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function failureFor(status: number): PurpleAirError {
  if (status === 401 || status === 403) return new PurpleAirError('key-refused', status);
  if (status === 402) return new PurpleAirError('points', status);
  if (status === 429) return new PurpleAirError('rate-limited', status);
  return new PurpleAirError('unavailable', status);
}

export function createPurpleAirClient(options: PurpleAirClientOptions): PurpleAirClient {
  const timeoutMs = options.timeoutMs ?? PURPLEAIR_TIMEOUT_MS;
  /** The last key checked and whether it was a READ key. Only the verdict for the same key value is reused. */
  let checked: {key: string; read: boolean} | undefined;
  /** A key check that failed (not a verdict), not retried for `KEY_CHECK_RETRY_MS` (security recheck N2). */
  let failedCheck: {key: string; at: number; failure: PurpleAirError} | undefined;

  function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
  }

  /** One GET with the key, the timeout joined to `signal`, and a capped body. */
  async function get(
    url: string,
    key: string,
    event: string,
    signal?: AbortSignal,
  ): Promise<{status: number; body: string}> {
    const started = options.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    try {
      const response = await raceSignal(
        options.fetch(url, {
          method: 'GET',
          headers: {'X-API-Key': key, Accept: 'application/json'},
          redirect: 'error',
          signal: combined,
        }),
        combined,
      );
      const body = response.status === 200 ? await raceSignal(readCapped(response, MAX_RESPONSE_BYTES), combined) : '';
      return {status: response.status, body};
    } catch (error) {
      const kind = error instanceof PurpleAirError ? error.kind : 'unavailable';
      options.log('warn', `${event}.failed`, {
        ms: options.now() - started,
        errorName: errorName(error),
        kind,
        timedOut: deadline.aborted,
      });
      throw new PurpleAirError(kind === 'too-large' ? 'too-large' : 'unavailable');
    }
  }

  /** The type check for one key value in flight, so a warm-up and a first question share one `/v1/keys` call. */
  let pendingCheck: {key: string; promise: Promise<void>} | undefined;

  /** Checks `key`'s type once, and records the verdict, or the failure for `KEY_CHECK_RETRY_MS`. */
  async function checkKey(key: string, signal?: AbortSignal): Promise<void> {
    let answer: {status: number; body: string};
    try {
      answer = await get(PURPLEAIR_KEYS_URL, key, 'air.purpleair.keyCheck', signal);
    } catch (error) {
      const failure = error instanceof PurpleAirError ? error : new PurpleAirError('unavailable');
      failedCheck = {key, at: options.now(), failure};
      throw failure;
    }
    const {status, body} = answer;
    if (status !== 200) {
      const failure = failureFor(status);
      failedCheck = {key, at: options.now(), failure};
      options.log('warn', 'air.purpleair.keyCheckRefused', {status, kind: failure.kind});
      throw failure;
    }
    failedCheck = undefined;
    let type: unknown;
    try {
      const parsed: unknown = JSON.parse(body);
      type = isRecord(parsed) ? parsed.api_key_type : undefined;
    } catch {
      type = undefined;
    }
    const keyType = typeof type === 'string' && /^[A-Z_]{1,20}$/.test(type) ? type : 'unrecognised';
    checked = {key, read: keyType === 'READ'};
    options.log(checked.read ? 'info' : 'warn', 'air.purpleair.keyType', {keyType, usable: checked.read});
  }

  /** The key, if it is stored and is a READ key; otherwise throws. */
  async function usableKey(signal?: AbortSignal): Promise<string> {
    const key = await options.readKey(signal);
    if (key === undefined || key === '') {
      options.log('warn', 'air.purpleair.noKey', {});
      throw new PurpleAirError('no-key');
    }
    if (checked === undefined || checked.key !== key) {
      if (failedCheck !== undefined && failedCheck.key === key) {
        const age = options.now() - failedCheck.at;
        if (age >= 0 && age < KEY_CHECK_RETRY_MS) throw failedCheck.failure;
      }
      if (pendingCheck === undefined || pendingCheck.key !== key) {
        const promise = checkKey(key, signal).finally(() => {
          if (pendingCheck?.promise === promise) pendingCheck = undefined;
        });
        promise.catch(() => {
          // Awaited below by whoever is still waiting; this only keeps an abandoned check from being unhandled.
        });
        pendingCheck = {key, promise};
      }
      try {
        await (signal === undefined ? pendingCheck.promise : raceSignal(pendingCheck.promise, signal));
      } catch (error) {
        throw error instanceof PurpleAirError ? error : new PurpleAirError('unavailable');
      }
    }
    if (checked === undefined || checked.key !== key || !checked.read) throw new PurpleAirError('not-read-key');
    return key;
  }

  async function sensors(url: string, what: string, signal?: AbortSignal): Promise<SensorRow[]> {
    const key = await usableKey(signal);
    const spent = options.takeBudget?.() ?? null;
    if (spent !== null) throw new PurpleAirError('budget');
    const started = options.now();
    const {status, body} = await get(url, key, 'air.purpleair', signal);
    if (status !== 200) {
      const failure = failureFor(status);
      options.log('warn', 'air.purpleair.refused', {ms: options.now() - started, status, kind: failure.kind, what});
      throw failure;
    }
    const rows = parseSensorsResponse(body);
    options.log('info', 'air.purpleair.call', {
      ms: options.now() - started,
      rows: rows.length,
      bytes: body.length,
      what,
    });
    return rows;
  }

  return {
    async warm() {
      try {
        await usableKey();
      } catch {
        // Logged where it failed; the first question will try again or answer honestly.
      }
    },
    sensorsInBox(box, fields, signal, locationType = 0) {
      return sensors(`${PURPLEAIR_SENSORS_URL}?${sensorsQuery(box, fields, locationType)}`, fields.join(','), signal);
    },
    sensorsByIndex(indexes, signal, locationType = 0) {
      return sensors(`${PURPLEAIR_SENSORS_URL}?${indexQuery(indexes, locationType)}`, 'show_only', signal);
    },
  };
}
