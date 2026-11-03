/**
 * The air-quality service (YA-36): `AirQualityPort` over PurpleAir, a geocoder and the home setting.
 *
 * - Here: the device's postal code, geocoded; if the device gave none, or it does not geocode, or the geocoder fails,
 *   the home setting. The answer says which was used.
 * - Named words (review C3), resolved near the household (the device's point, else home):
 *   1. a PurpleAir sensor within `SENSOR_SEARCH_RADIUS_KM` whose name matches the words strongly wins;
 *   2. otherwise a town or postal code the geocoder ranks first, when it is within `FAR_PLACE_KM` and matched well;
 *   3. otherwise a sensor whose name matches the words at all;
 *   4. otherwise a distant or weaker place: said by its own name ("Portland, Oregon"), or, when two or three places
 *      share that name, offered as a choice ("Did you mean Springfield, Illinois, or Springfield, Missouri?").
 * - The figure for a point (review C4): the sensors within `NEAR_RADIUS_KM`; only when fewer than `MIN_SENSORS` of them
 *   are usable, a second fetch to `WIDE_RADIUS_KM`, merged with the first (never replacing it), with outliers judged
 *   within distance bands and the nearest sensors weighted most. If the widening fails, the near reading stands, marked
 *   as few sensors.
 *
 * Spending (review S-P2): an area's figure is cached for `CACHE_TTL_MS` under its coordinates rounded to two decimals,
 * and re-checked for freshness when served; geocoder results for `GEOCODE_CACHE_TTL_MS` under the query, country and
 * bias; a name search's list of names for `NAME_LIST_TTL_MS`. `AirLimits` caps lookups per speaker and per container,
 * and PurpleAir and geocoder calls per hour and day; past a cap the answer is `busy`. Failures are not cached. One
 * `air.usage` line per lookup carries CloudWatch Embedded Metric Format metrics (calls made, and the window counts).
 *
 * Time (review P2-10): widening and the sensor search are skipped when less than `OPTIONAL_STEP_MS` remains before the
 * turn's deadline; every call is cut by the turn's signal. Every method resolves; nothing here throws to the core.
 *
 * Logs: outcomes, counts, radii, scores and timings at `info`. Never coordinates, postal codes, place words, place or
 * sensor names or ids, and never the key (which this module never sees).
 */
import {matchesEveryWord, summaryScore} from '../core/fuzzy.ts';
import type {
  AirLookupContext,
  AirQualityHere,
  AirQualityNamed,
  AirQualityPort,
  AirQualityReading,
  AirQualityResult,
  DeviceLocation,
  VoiceLogger,
} from '../core/types.ts';
import {aggregate, disagreeWildly, FRESH_MS, MIN_SENSORS, minutesSince, type Aggregate} from './aggregate.ts';
import {TtlCache} from './cache.ts';
import {GeocoderError, type GeocodeCandidate, type GeocodeQuery, type Geocoder} from './geocoder.ts';
import {boxAround, distanceKm, isValidLatLon, roundedKey, type LatLon} from './geo.ts';
import {AirLimits} from './limits.ts';
import {
  MAX_AGE_SECONDS,
  NAME_FIELDS,
  PurpleAirError,
  READING_FIELDS,
  type PurpleAirClient,
  type SensorRow,
} from './purpleair.ts';

export const NEAR_RADIUS_KM = 5;
export const WIDE_RADIUS_KM = 15;
/** The name search's box: sensors of that name this close to the household. */
export const SENSOR_SEARCH_RADIUS_KM = 15;
export const MAX_SENSORS = 30;
/** Sensors a name search may average, when several share the best match. */
export const MAX_NAMED_SENSORS = 5;
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NAME_LIST_TTL_MS = 60 * 60 * 1000;
/** A place further than this from the household is said by its own name, and rivals of that name are asked about. */
export const FAR_PLACE_KM = 300;
/**
 * `MatchScores.Overall` at or above this is a good match; below `WEAK_PLACE_SCORE` it is no match. The provider does
 * not document how scores are calibrated [UNVERIFIED]; they are logged at info so the thresholds can be tuned.
 */
export const GOOD_PLACE_SCORE = 0.8;
export const WEAK_PLACE_SCORE = 0.5;
/** A rival place of the same name counts when its score is at least this close to the best one's. */
export const RIVAL_SCORE_GAP = 0.15;
/** Optional steps (widening, the sensor search) need at least this long before the deadline. */
export const OPTIONAL_STEP_MS = 2500;
const CACHE_ENTRIES = 200;
export const METRICS_NAMESPACE = 'YouTrackVoice/AirQuality';

/** The owner's home setting: a point ("46.87,-113.99") or a place name or postal code to geocode ("Missoula, MT"). */
export type HomeLocation = {kind: 'point'; point: LatLon} | {kind: 'place'; text: string};

/** Exactly two numbers, separated by a comma or a space: coordinates, and never a postal code (recheck N4). */
const TWO_NUMBERS = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)([+-]?\d+(?:\.\d+)?)\s*$/;
/** JavaScript's own number words and exponents, which `Number()` would read but nobody means as a place. */
const NUMBER_TRICKS = /\b(?:nan|infinity)\b|\d[eE][+-]?\d/i;

/**
 * The HOME_LOCATION setting (review C1), never throwing: empty is no home; exactly two numbers ("lat,lon" or "lat lon")
 * are coordinates, a point when in range and `invalid` otherwise; digits and hyphens are a postal code, and any other
 * text a place name, both geocoded when first used. `NaN`, `Infinity`, exponents, and text with no letters or digits
 * are `unreadable`. The caller logs `invalid` and `unreadable` at warn and runs with no home fallback; nothing else is
 * affected.
 */
export function parseHomeLocation(
  value: string | undefined,
): {home: HomeLocation} | {home?: undefined; invalid?: 'coordinates' | 'unreadable' | 'too-long'} {
  const text = value?.trim() ?? '';
  if (text === '') return {};
  if (text.length > 200) return {invalid: 'too-long'};
  if (NUMBER_TRICKS.test(text) || !/[\p{L}\p{N}]/u.test(text)) return {invalid: 'unreadable'};
  const match = TWO_NUMBERS.exec(text);
  if (match !== null) {
    const point = {lat: Number(match[1]), lon: Number(match[2])};
    return isValidLatLon(point) ? {home: {kind: 'point', point}} : {invalid: 'coordinates'};
  }
  if (/^[\d\s-]+$/.test(text)) return {home: {kind: 'place', text}};
  if (/^[\d\s.,+-]+$/.test(text)) return {invalid: 'coordinates'};
  return {home: {kind: 'place', text}};
}

const POSTAL_SHAPED = /^[\s\d-]+$/;

export interface AirQualityServiceOptions {
  purpleAir: PurpleAirClient;
  geocoder: Geocoder;
  home?: HomeLocation;
  now: () => number;
  log: VoiceLogger;
  limits?: AirLimits;
  cacheTtlMs?: number;
  /** The household's indoor PurpleAir sensor, selected by stable index or resolved once by exact name near home. */
  indoorSensorName?: string;
  indoorSensorIndex?: number;
}

/** A spending budget or rate limit said no. */
class BusyError extends Error {
  readonly limit: string;

  constructor(limit: string) {
    super(`air quality busy: ${limit}`);
    this.name = 'BusyError';
    this.limit = limit;
  }
}

/** An area's figure as cached: the reading time, not its age, so a served answer is aged when it is served. */
type CachedArea =
  | {kind: 'reading'; reading: Omit<AirQualityReading, 'ageMinutes'>; newestMs: number}
  | {kind: 'stale'; radiusKm: number; newestMs: number}
  | {kind: 'noSensors'; radiusKm: number};

/** Per-lookup bookkeeping: the turn's context, and the paid calls made. */
interface Lookup {
  context: AirLookupContext;
  method: string;
  started: number;
  purpleAirCalls: number;
  geocodeCalls: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function radiusOf(result: AirQualityResult): number | undefined {
  if (result.kind === 'reading') return result.reading.radiusKm;
  return result.kind === 'noSensors' || result.kind === 'stale' ? result.radiusKm : undefined;
}

function normalisedQuery(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function createAirQualityService(options: AirQualityServiceOptions): AirQualityPort {
  const {purpleAir, geocoder, log, now} = options;
  const ttlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
  const limits = options.limits ?? new AirLimits(now);
  const areas = new TtlCache<CachedArea>({ttlMs, maxEntries: CACHE_ENTRIES, now});
  // Here/home is intentionally not the same cached value as a place: YA-37 speaks one nearest valid sensor.
  const homes = new TtlCache<CachedArea>({ttlMs, maxEntries: CACHE_ENTRIES, now});
  const named = new TtlCache<CachedArea>({ttlMs, maxEntries: CACHE_ENTRIES, now});
  const indoors = new TtlCache<CachedArea>({ttlMs, maxEntries: CACHE_ENTRIES, now});
  const nameLists = new TtlCache<SensorRow[]>({ttlMs: NAME_LIST_TTL_MS, maxEntries: CACHE_ENTRIES, now});
  const geocodes = new TtlCache<GeocodeCandidate[]>({ttlMs: GEOCODE_CACHE_TTL_MS, maxEntries: 500, now});
  let indoorIndex = options.indoorSensorIndex;

  const timeLeft = (lookup: Lookup): number =>
    lookup.context.deadline === undefined ? Number.POSITIVE_INFINITY : lookup.context.deadline - now();

  const exhausted = new Set<string>();
  function refuse(budget: string): never {
    if (!exhausted.has(budget)) {
      exhausted.add(budget);
      log('warn', 'air.budget.exhausted', {budget, ...limits.usage()});
    }
    throw new BusyError(budget);
  }

  async function geocode(lookup: Lookup, query: GeocodeQuery): Promise<GeocodeCandidate[]> {
    const bias = query.bias === undefined ? '' : roundedKey({lat: query.bias.lat, lon: query.bias.lon}).slice(0, 12);
    const key = `${normalisedQuery(query.text)}|${query.countryCode ?? ''}|${bias}`;
    const cached = geocodes.get(key);
    if (cached !== undefined) {
      log('info', 'air.cache.hit', {method: lookup.method, kind: 'geocode'});
      return cached;
    }
    const spent = limits.takeGeocode();
    if (spent !== null) refuse(spent);
    exhausted.delete('geocode-day');
    lookup.geocodeCalls++;
    const candidates = await geocoder.search(query, lookup.context.signal);
    geocodes.set(key, candidates);
    return candidates;
  }

  async function purple<T>(lookup: Lookup, call: () => Promise<T>): Promise<T> {
    const spent = limits.takePurpleAir();
    if (spent !== null) refuse(spent);
    exhausted.delete('purpleair-hour');
    exhausted.delete('purpleair-day');
    lookup.purpleAirCalls++;
    return call();
  }

  /** A point for a postal code or place text, or why there is none. Geocoder failures are "failed", not thrown. */
  async function locate(
    lookup: Lookup,
    query: GeocodeQuery,
  ): Promise<{ok: true; point: LatLon; region?: string} | {ok: false; reason: 'none' | 'not-found' | 'failed'}> {
    try {
      const candidates = await geocode(lookup, query);
      const best = candidates.find((candidate) => candidate.score >= WEAK_PLACE_SCORE || candidate.score === 0);
      if (best === undefined) return {ok: false, reason: 'not-found'};
      return best.region === undefined
        ? {ok: true, point: best.point}
        : {ok: true, point: best.point, region: best.region};
    } catch (error) {
      if (error instanceof BusyError) throw error;
      if (!(error instanceof GeocoderError)) log('warn', 'air.geocoder.threw', {errorName: errorName(error)});
      return {ok: false, reason: 'failed'};
    }
  }

  function locateDevice(lookup: Lookup, device: DeviceLocation | undefined) {
    if (device === undefined || device.postalCode.trim() === '') {
      return Promise.resolve({ok: false as const, reason: 'none' as const});
    }
    return locate(lookup, {text: device.postalCode, countryCode: device.countryCode});
  }

  async function locateHome(lookup: Lookup) {
    const home = options.home;
    if (home === undefined) return {ok: false as const, reason: 'none' as const};
    if (home.kind === 'point') return {ok: true as const, point: home.point};
    const located = await locate(lookup, {text: home.text});
    if (!located.ok && located.reason === 'not-found') log('warn', 'air.home.notFound', {});
    return located;
  }

  /** The household's point for biasing a named lookup, and its region when geocoding told it: device, else home. */
  async function reference(
    lookup: Lookup,
    device: DeviceLocation | undefined,
  ): Promise<{point: LatLon; region?: string} | undefined> {
    const fromDevice = await locateDevice(lookup, device);
    if (fromDevice.ok) return fromDevice;
    const fromHome = await locateHome(lookup);
    return fromHome.ok ? fromHome : undefined;
  }

  function served(cached: CachedArea): AirQualityResult | undefined {
    const at = now();
    if (cached.kind === 'reading') {
      // Past freshness since it was cached: not served, so a new lookup can say "stale" honestly (review P2-5).
      if (at - cached.newestMs > FRESH_MS) return undefined;
      return {kind: 'reading', reading: {...cached.reading, ageMinutes: minutesSince(at, cached.newestMs)}};
    }
    if (cached.kind === 'stale') {
      if (at - cached.newestMs > MAX_AGE_SECONDS * 1000) return undefined;
      return {kind: 'stale', radiusKm: cached.radiusKm, ageMinutes: minutesSince(at, cached.newestMs)};
    }
    return cached;
  }

  function fromAggregate(
    figure: Aggregate,
    radiusKm: number,
    fewSensors: boolean,
    distanceMetres?: number,
  ): CachedArea {
    if (figure.aqi !== undefined && figure.category !== undefined && figure.newestMs !== undefined) {
      const reading: Omit<AirQualityReading, 'ageMinutes'> = {
        aqi: figure.aqi,
        category: figure.category,
        sensors: figure.used,
        sources: {PurpleAir: figure.used},
        averaging: '10-minute average',
        // Readings that disagree are always a rough guide (recheck N1).
        fewSensors: fewSensors || figure.disagreement !== undefined,
        radiusKm,
      };
      if (distanceMetres !== undefined) reading.distanceMetres = distanceMetres;
      if (figure.lowConfidence) reading.lowConfidence = true;
      if (figure.disagreement !== undefined) reading.disagreement = figure.disagreement;
      return {kind: 'reading', reading, newestMs: figure.newestMs};
    }
    if (figure.newestMs !== undefined) return {kind: 'stale', radiusKm, newestMs: figure.newestMs};
    return {kind: 'noSensors', radiusKm};
  }

  /** Rows within `radiusKm` of `point`, fresh first, then nearest first, at most `MAX_SENSORS`. */
  function nearest(rows: readonly SensorRow[], point: LatLon, minKm: number, maxKm: number): SensorRow[] {
    const at = now();
    return rows
      .map((row) => ({row, km: distanceKm(point, row), stale: at - row.lastSeenMs > FRESH_MS}))
      .filter((entry) => entry.km > minKm && entry.km <= maxKm)
      .sort((a, b) => Number(a.stale) - Number(b.stale) || a.km - b.km)
      .map((entry) => entry.row);
  }

  /** The figure for the area around a point: near first, widened and merged only if too few (see the header). */
  async function area(lookup: Lookup, point: LatLon): Promise<AirQualityResult> {
    const key = roundedKey(point);
    const cached = areas.get(key);
    const fromCache = cached === undefined ? undefined : served(cached);
    if (fromCache !== undefined) {
      log('info', 'air.cache.hit', {method: lookup.method, kind: 'area', outcome: fromCache.kind});
      return fromCache;
    }
    const nearRows = nearest(
      await purple(lookup, () =>
        purpleAir.sensorsInBox(boxAround(point, NEAR_RADIUS_KM), READING_FIELDS, lookup.context.signal),
      ),
      point,
      -1,
      NEAR_RADIUS_KM,
    ).slice(0, MAX_SENSORS);
    const near = aggregate(nearRows, now(), {center: point, nearKm: NEAR_RADIUS_KM});
    const nearFigure = fromAggregate(near, NEAR_RADIUS_KM, near.nearUsed < MIN_SENSORS);
    log('info', 'air.area', {method: lookup.method, pass: 'near', rows: nearRows.length, ...counts(near)});
    if (near.nearUsed >= MIN_SENSORS) {
      areas.set(key, nearFigure);
      return served(nearFigure) ?? {kind: 'unavailable'};
    }
    if (timeLeft(lookup) < OPTIONAL_STEP_MS) {
      log('info', 'air.area.widenSkipped', {method: lookup.method, reason: 'deadline', msLeft: timeLeft(lookup)});
      return served(nearFigure) ?? {kind: 'unavailable'};
    }
    let wideRows: SensorRow[];
    try {
      wideRows = await purple(lookup, () =>
        purpleAir.sensorsInBox(boxAround(point, WIDE_RADIUS_KM), READING_FIELDS, lookup.context.signal),
      );
    } catch (error) {
      // Review P2-6: the near reading stands, marked few, and is not cached.
      if (nearFigure.kind === 'reading') {
        log('warn', 'air.area.widenFailed', {method: lookup.method, errorName: errorName(error), kept: 'near'});
        return served(nearFigure) ?? {kind: 'unavailable'};
      }
      throw error;
    }
    const merged = [...nearRows, ...nearest(wideRows, point, NEAR_RADIUS_KM, WIDE_RADIUS_KM)].slice(0, MAX_SENSORS);
    const wide = aggregate(merged, now(), {center: point, nearKm: NEAR_RADIUS_KM});
    const radiusKm = wide.used > wide.nearUsed || wide.used === 0 ? WIDE_RADIUS_KM : NEAR_RADIUS_KM;
    const few = wide.used < MIN_SENSORS || (wide.nearUsed > 0 && wide.nearUsed < MIN_SENSORS);
    const figure = fromAggregate(wide, radiusKm, few);
    log('info', 'air.area', {method: lookup.method, pass: 'merged', rows: merged.length, ...counts(wide)});
    areas.set(key, figure);
    return served(figure) ?? {kind: 'unavailable'};
  }

  /** The nearest fresh, plausible and non-disagreeing outdoor sensor for home/here (YA-37). */
  function nearestGood(rows: readonly SensorRow[], point: LatLon): SensorRow | undefined {
    const ordered = nearest(rows, point, -1, WIDE_RADIUS_KM);
    for (const [position, candidate] of ordered.entries()) {
      const one = aggregate([candidate], now(), {center: point, nearKm: WIDE_RADIUS_KM});
      if (one.used !== 1 || one.pm25 === undefined) continue;
      // A nearer sensor is judged against the group further out. Once we walk past it, it cannot make every
      // subsequent candidate look anomalous merely by disagreeing itself.
      const others = aggregate(ordered.slice(position + 1), now(), {center: point, nearKm: WIDE_RADIUS_KM});
      // A lone sensor that wildly disagrees with good neighbours is anomalous; walk outward instead.
      if (
        ordered.length - position >= MIN_SENSORS &&
        others.pm25 !== undefined &&
        disagreeWildly(one.pm25, others.pm25)
      )
        continue;
      return candidate;
    }
    return undefined;
  }

  async function home(lookup: Lookup, point: LatLon): Promise<AirQualityResult> {
    const key = roundedKey(point);
    const cached = homes.get(key);
    const servedHome = cached === undefined ? undefined : served(cached);
    if (servedHome !== undefined) return servedHome;
    const close = await purple(lookup, () =>
      purpleAir.sensorsInBox(boxAround(point, NEAR_RADIUS_KM), READING_FIELDS, lookup.context.signal),
    );
    let candidate = nearestGood(close, point);
    let rows = close;
    // Unlike a place average, home must inspect the widened ring even when a close sensor exists: only that lets us
    // reject a close but wildly disagreeing reading against the other good sensors (YA-37).
    if (timeLeft(lookup) >= OPTIONAL_STEP_MS) {
      try {
        const wide = await purple(lookup, () =>
          purpleAir.sensorsInBox(boxAround(point, WIDE_RADIUS_KM), READING_FIELDS, lookup.context.signal),
        );
        // The wider PurpleAir box includes the close box. Keep one row per sensor before evaluating distance/order.
        rows = [...new Map([...close, ...wide].map((row) => [row.index ?? `${row.lat},${row.lon}`, row])).values()];
        candidate = nearestGood(rows, point);
      } catch (error) {
        if (candidate === undefined) throw error;
        log('warn', 'air.home.widenFailed', {method: lookup.method, errorName: errorName(error)});
      }
    }
    if (candidate === undefined) {
      const figure = aggregate(rows, now(), {center: point, nearKm: WIDE_RADIUS_KM});
      return fromAggregate(figure, WIDE_RADIUS_KM, true).kind === 'stale'
        ? {kind: 'stale', radiusKm: WIDE_RADIUS_KM, ageMinutes: minutesSince(now(), figure.newestMs ?? now())}
        : {kind: 'noSensors', radiusKm: WIDE_RADIUS_KM};
    }
    const figure = aggregate([candidate], now(), {center: point, nearKm: WIDE_RADIUS_KM});
    const result = fromAggregate(
      figure,
      Math.max(1, Math.round(distanceKm(point, candidate))),
      false,
      Math.max(1, Math.round(distanceKm(point, candidate) * 1000)),
    );
    homes.set(key, result);
    return served(result) ?? {kind: 'unavailable'};
  }

  function counts(figure: Aggregate): Record<string, number> {
    return {
      used: figure.used,
      nearUsed: figure.nearUsed,
      outliers: figure.outliers,
      stale: figure.stale,
      unusable: figure.unusable,
    };
  }

  /** Sensors near `point` whose names match `words`: how strongly, and their indexes. */
  async function matchSensors(
    lookup: Lookup,
    words: string,
    point: LatLon,
  ): Promise<{strength: 'strong' | 'weak' | 'none'; indexes: number[]}> {
    const key = roundedKey(point);
    let rows = nameLists.get(key);
    if (rows === undefined) {
      rows = await purple(lookup, () =>
        purpleAir.sensorsInBox(boxAround(point, SENSOR_SEARCH_RADIUS_KM), NAME_FIELDS, lookup.context.signal),
      );
      nameLists.set(key, rows);
    } else {
      log('info', 'air.cache.hit', {method: lookup.method, kind: 'names'});
    }
    const scored = rows
      .filter((row) => row.index !== undefined && matchesEveryWord(words, row.name))
      .map((row) => ({row, score: summaryScore(words, row.name), covers: summaryScore(row.name, words)}));
    if (scored.length === 0) return {strength: 'none', indexes: []};
    const best = Math.max(...scored.map((entry) => entry.score));
    const top = scored.filter((entry) => entry.score === best).slice(0, MAX_NAMED_SENSORS);
    // Strong: every word said exactly, and more than half of the sensor's own name said, so "Missoula" is not
    // "Downtown Missoula" but "Rattlesnake Creek" is "Rattlesnake Creek Upper".
    const strong = best === 1 && top.some((entry) => entry.covers > 0.5);
    return {strength: strong ? 'strong' : 'weak', indexes: top.map((entry) => entry.row.index as number)};
  }

  async function sensorReading(lookup: Lookup, indexes: readonly number[]): Promise<AirQualityResult> {
    const key = `sensors:${[...indexes].sort((a, b) => a - b).join(',')}`;
    const cached = named.get(key);
    const fromCache = cached === undefined ? undefined : served(cached);
    if (fromCache !== undefined) {
      log('info', 'air.cache.hit', {method: lookup.method, kind: 'sensor'});
      return fromCache;
    }
    const rows = await purple(lookup, () => purpleAir.sensorsByIndex(indexes, lookup.context.signal));
    const figure = aggregate(rows, now(), {allowLowConfidence: true});
    const result = fromAggregate(figure, 0, false);
    named.set(key, result);
    return served(result) ?? {kind: 'unavailable'};
  }

  function begin(method: string, context: AirLookupContext | undefined): Lookup {
    return {context: context ?? {}, method, started: now(), purpleAirCalls: 0, geocodeCalls: 0};
  }

  function finish(lookup: Lookup, result: AirQualityResult, extra: Record<string, unknown> = {}): void {
    log('info', 'air.lookup', {
      method: lookup.method,
      outcome: result.kind,
      aqi: result.kind === 'reading' ? result.reading.aqi : undefined,
      sensors: result.kind === 'reading' ? result.reading.sensors : undefined,
      radiusKm: radiusOf(result),
      ms: now() - lookup.started,
      ...extra,
    });
    const usage = limits.usage();
    // CloudWatch Embedded Metric Format: the log line itself becomes metrics, with no API call or permission.
    log('info', 'air.usage', {
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [
          {
            Namespace: METRICS_NAMESPACE,
            Dimensions: [[]],
            Metrics: [
              {Name: 'Lookups', Unit: 'Count'},
              {Name: 'PurpleAirCalls', Unit: 'Count'},
              {Name: 'GeocodeCalls', Unit: 'Count'},
            ],
          },
        ],
      },
      Lookups: 1,
      PurpleAirCalls: lookup.purpleAirCalls,
      GeocodeCalls: lookup.geocodeCalls,
      ...usage,
    });
  }

  /** Runs a lookup: the rate limit first, then `run`; a budget refusal is `busy`, any other failure `unavailable`. */
  async function guarded<T>(lookup: Lookup, run: () => Promise<T>, onFailure: (result: AirQualityResult) => T) {
    const refusal = limits.takeLookup(lookup.context.speaker);
    if (refusal !== null) {
      log('warn', 'air.limit', {method: lookup.method, limit: refusal, ...limits.usage()});
      const busy: AirQualityResult = {kind: 'busy'};
      finish(lookup, busy, {limit: refusal});
      return onFailure(busy);
    }
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof BusyError;
      const result: AirQualityResult = {kind: busy ? 'busy' : 'unavailable'};
      log('warn', 'air.lookup.failed', {
        method: lookup.method,
        errorName: errorName(error),
        kind: error instanceof PurpleAirError ? error.kind : busy ? (error as BusyError).limit : undefined,
        ms: now() - lookup.started,
      });
      finish(lookup, result);
      return onFailure(result);
    }
  }

  return {
    lookupIndoor(context) {
      const lookup = begin('indoor', context);
      return guarded<AirQualityResult>(
        lookup,
        async () => {
          if (indoorIndex === undefined) {
            const name = options.indoorSensorName?.trim();
            if (name === undefined || name === '') return {kind: 'notFound'};
            const located = await locateHome(lookup);
            if (!located.ok) return located.reason === 'none' ? {kind: 'noLocation'} : {kind: 'unavailable'};
            const rows = await purple(lookup, () =>
              purpleAir.sensorsInBox(boxAround(located.point, WIDE_RADIUS_KM), NAME_FIELDS, lookup.context.signal, 1),
            );
            indoorIndex = rows.find(
              (row) => row.index !== undefined && normalisedQuery(row.name) === normalisedQuery(name),
            )?.index;
            if (indoorIndex === undefined) return {kind: 'notFound'};
          }
          const key = `indoor:${indoorIndex}`;
          const cached = indoors.get(key);
          const fromCache = cached === undefined ? undefined : served(cached);
          if (fromCache !== undefined) {
            log('info', 'air.cache.hit', {method: lookup.method, kind: 'indoor'});
            finish(lookup, fromCache, {indoor: true});
            return fromCache;
          }
          const rows = await purple(lookup, () =>
            purpleAir.sensorsByIndex([indoorIndex as number], lookup.context.signal, 1),
          );
          // EPA cautions that a correction developed from an outdoor collocation may not apply indoors. Keep this
          // single sensor's PurpleAir 10-minute PM2.5 raw rather than claiming an EPA-corrected indoor measurement.
          const figure = aggregate(rows, now(), {correction: 'raw', allowLowConfidence: true});
          const result = fromAggregate(figure, 0, false);
          indoors.set(key, result);
          const answer = served(result) ?? {kind: 'unavailable'};
          finish(lookup, answer, {indoor: true});
          return answer;
        },
        (result) => result,
      );
    },
    lookupHere(device, context) {
      const lookup = begin('here', context);
      let used: AirQualityHere['used'] = 'none';
      return guarded<AirQualityHere>(
        lookup,
        async () => {
          used = 'device';
          let located = await locateDevice(lookup, device);
          const deviceReason = located.ok ? 'located' : located.reason;
          if (!located.ok) {
            used = 'home';
            located = await locateHome(lookup);
          }
          if (!located.ok) {
            const noHome = options.home === undefined || located.reason === 'not-found';
            const answer: AirQualityHere = noHome
              ? {used: 'none', result: {kind: 'noLocation'}}
              : {used: 'home', result: {kind: 'unavailable'}};
            finish(lookup, answer.result, {used: answer.used, device: deviceReason});
            return answer;
          }
          const result = await home(lookup, located.point);
          finish(lookup, result, {used, device: deviceReason});
          return {used, result};
        },
        // Review P3-15: the location actually in use when the failure happened.
        (result) => ({used, result}),
      );
    },

    lookupNamed(words, device, context) {
      const lookup = begin('named', context);
      return guarded<AirQualityNamed>(
        lookup,
        async () => {
          const household = await reference(lookup, device);
          const bias = household?.point;
          const postal = POSTAL_SHAPED.test(words) && device !== undefined ? device.countryCode : undefined;
          const query: GeocodeQuery = {text: words};
          if (bias !== undefined) query.bias = bias;
          if (postal !== undefined) query.countryCode = postal;
          let candidates: GeocodeCandidate[];
          let geocodeFailed = false;
          try {
            candidates = await geocode(lookup, query);
          } catch (error) {
            if (error instanceof BusyError) throw error;
            candidates = [];
            geocodeFailed = true;
            log('warn', 'air.named.geocodeFailed', {errorName: errorName(error)});
            if (bias === undefined) throw error;
          }
          const usable = candidates.filter((candidate) => candidate.score >= WEAK_PLACE_SCORE || candidate.score === 0);
          const best = usable[0];
          const kmOf = (candidate: GeocodeCandidate): number | undefined =>
            bias === undefined ? undefined : distanceKm(bias, candidate.point);
          const nearBest = best !== undefined && (kmOf(best) ?? Number.POSITIVE_INFINITY) <= FAR_PLACE_KM;
          const goodBest = best !== undefined && (best.score >= GOOD_PLACE_SCORE || best.score === 0);
          // Recheck N2: a place is said with its state (or region) unless it is certainly in the household's own region
          // and no rival of the same name was offered.
          const spokenName = (candidate: GeocodeCandidate): string => {
            const rival = usable.some(
              (other) => other !== candidate && other.key === candidate.key && other.name !== candidate.name,
            );
            const sameRegion =
              household?.region !== undefined &&
              candidate.region !== undefined &&
              household.region === candidate.region;
            return sameRegion && !rival ? candidate.own : candidate.name;
          };
          const decide = (decision: string, answer: AirQualityNamed, result: AirQualityResult) => {
            finish(lookup, result, {
              decision,
              candidates: candidates.length,
              bestScore: best?.score,
              bestFar: best === undefined ? undefined : !nearBest,
            });
            return answer;
          };

          if (context?.chosen === true && best !== undefined) {
            const result = await area(lookup, best.point);
            return decide('chosen', {matched: 'place', name: spokenName(best), result}, result);
          }

          let sensors: {strength: 'strong' | 'weak' | 'none'; indexes: number[]} = {strength: 'none', indexes: []};
          if (bias !== undefined && timeLeft(lookup) >= OPTIONAL_STEP_MS) {
            try {
              sensors = await matchSensors(lookup, words, bias);
            } catch (error) {
              // The name search is a second chance, not the answer: a failure leaves the place to be tried.
              if (error instanceof BusyError) throw error;
              log('warn', 'air.named.sensorSearchFailed', {errorName: errorName(error)});
            }
          }
          if (sensors.strength === 'strong') {
            const result = await sensorReading(lookup, sensors.indexes);
            return decide('sensor-strong', {matched: 'sensor', result}, result);
          }
          if (best !== undefined && nearBest && goodBest) {
            const result = await area(lookup, best.point);
            return decide('place-near', {matched: 'place', name: spokenName(best), result}, result);
          }
          if (sensors.strength === 'weak') {
            const result = await sensorReading(lookup, sensors.indexes);
            return decide('sensor-weak', {matched: 'sensor', result}, result);
          }
          if (best === undefined) {
            // Places could not be searched: "not found" would not be true.
            const result: AirQualityResult = {kind: geocodeFailed ? 'unavailable' : 'notFound'};
            return decide('none', {matched: 'none', result}, result);
          }
          if (nearBest) {
            // A near place matched weakly: said by its own name, so a wrong guess is heard at once.
            const result = await area(lookup, best.point);
            return decide('place-near-weak', {matched: 'place', name: spokenName(best), result}, result);
          }
          const rivals = usable.filter(
            (candidate, index) =>
              index > 0 &&
              candidate.key === best.key &&
              candidate.name !== best.name &&
              best.score - candidate.score <= RIVAL_SCORE_GAP,
          );
          const names = [...new Set([best.name, ...rivals.map((candidate) => candidate.name)])].slice(0, 3);
          if (names.length > 1) {
            const answer: AirQualityNamed = {matched: 'choice', places: names};
            finish(lookup, {kind: 'notFound'}, {decision: 'choice', choices: names.length});
            return answer;
          }
          const result = await area(lookup, best.point);
          return decide('place-far', {matched: 'place', name: best.name, result}, result);
        },
        (result) => ({matched: 'none', result}),
      );
    },
  };
}
