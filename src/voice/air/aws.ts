/**
 * The air-quality service as the Lambda runs it (YA-36): the PurpleAir read key from SSM, Amazon Location's Places
 * API for geocoding, the global fetch, and the home setting from the environment.
 *
 * Nothing here is built at cold start. The first air-quality question builds it, so a missing SDK, key or permission
 * can only cost air quality, never the tracker; a failed build is logged and tried again on the next question, and in
 * the meantime the answer is `unavailable`.
 *
 * The SDKs. `@aws-sdk/client-ssm` and `@aws-sdk/client-geo-places` ship in the Lambda Node.js runtime but are not
 * dependencies of this repository, so, as in `alexa/deploy/lambda-entry.ts`, each is imported dynamically by a
 * specifier held in a variable and checked at runtime for the one constructor used.
 *
 * The key. Read with decryption from exactly `PURPLEAIR_KEY_PARAMETER` (the role may read nothing else), kept for
 * `KEY_CACHE_MS` so a rotated key is picked up within minutes, and passed only to the PurpleAir client's header. It is
 * never logged, never in an error message, and never in the environment.
 */
import type {AirQualityPort, VoiceLogger} from '../core/types.ts';
import {createAwsGeocoder, type GeoPlacesClient} from './geocoder.ts';
import {AirLimits} from './limits.ts';
import {createPurpleAirClient, raceSignal, type AirFetch} from './purpleair.ts';
import {createAirQualityService, parseHomeLocation, type HomeLocation} from './service.ts';

export const SSM_SDK_MODULE = '@aws-sdk/client-ssm';
export const GEO_PLACES_SDK_MODULE = '@aws-sdk/client-geo-places';

/** The one parameter the skill's role may read: a SecureString the owner stores (docs/voice/alexa.md). */
export const PURPLEAIR_KEY_PARAMETER = '/youtrack-voice/purpleair/read-key';
export const KEY_CACHE_MS = 15 * 60 * 1000;

/** Two attempts and short timeouts, inside the turn's budget. */
export const AIR_SDK_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: {requestTimeout: 1500, connectionTimeout: 500},
} as const;

export interface SsmGetParameterClient {
  getParameter(
    input: {Name: string; WithDecryption: true},
    options?: {abortSignal?: AbortSignal},
  ): Promise<{Parameter?: {Value?: unknown}}>;
}

/** The longest the key read from SSM may take, and it is also cut by the turn's signal (review P2-10). */
export const KEY_READ_TIMEOUT_MS = 1000;

export interface AirSettings {
  enabled: boolean;
  home?: HomeLocation;
  indoorSensorName?: string;
  indoorSensorIndex?: number;
}

/**
 * AIR_QUALITY (on/off, default off) and HOME_LOCATION. Never throws (review C1): a bad AIR_QUALITY is off, and a bad
 * HOME_LOCATION is no home fallback, each logged at warn by kind, never by value. With air quality off, HOME_LOCATION
 * is not read at all.
 */
export function airSettings(env: Readonly<Record<string, string | undefined>>, log: VoiceLogger): AirSettings {
  const raw = env.AIR_QUALITY?.trim() ?? '';
  if (raw !== '' && raw !== 'on' && raw !== 'off') log('warn', 'air.settings.invalid', {setting: 'AIR_QUALITY'});
  if (raw !== 'on') return {enabled: false};
  const parsed = parseHomeLocation(env.HOME_LOCATION);
  const indoorSensorName = env.INDOOR_SENSOR_NAME?.trim() || undefined;
  const rawIndex = env.INDOOR_SENSOR_INDEX?.trim();
  const indoorSensorIndex =
    rawIndex !== undefined && /^\d+$/.test(rawIndex) && Number(rawIndex) > 0 ? Number(rawIndex) : undefined;
  if (rawIndex !== undefined && indoorSensorIndex === undefined)
    log('warn', 'air.settings.invalid', {setting: 'INDOOR_SENSOR_INDEX'});
  if (parsed.home !== undefined) {
    return {
      enabled: true,
      home: parsed.home,
      ...(indoorSensorName === undefined ? {} : {indoorSensorName}),
      ...(indoorSensorIndex === undefined ? {} : {indoorSensorIndex}),
    };
  }
  if ('invalid' in parsed && parsed.invalid !== undefined) {
    log('warn', 'air.home.invalid', {setting: 'HOME_LOCATION', problem: parsed.invalid, fallback: 'none'});
  }
  return {enabled: true};
}

function hasConstructor(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * A key reader over SSM that caches the value for `KEY_CACHE_MS`. A missing parameter reads as `undefined`. Each read
 * is cut at `KEY_READ_TIMEOUT_MS` and by the caller's signal.
 */
export function ssmReadKey(
  client: () => Promise<SsmGetParameterClient>,
  now: () => number,
  log: VoiceLogger,
): (signal?: AbortSignal) => Promise<string | undefined> {
  let cached: {value: string | undefined; at: number} | undefined;
  return async (signal) => {
    if (cached !== undefined && now() - cached.at < KEY_CACHE_MS && now() >= cached.at) return cached.value;
    const deadline = AbortSignal.timeout(KEY_READ_TIMEOUT_MS);
    const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    let value: string | undefined;
    try {
      const ssm = await raceSignal(client(), combined);
      const response = await raceSignal(
        ssm.getParameter({Name: PURPLEAIR_KEY_PARAMETER, WithDecryption: true}, {abortSignal: combined}),
        combined,
      );
      const raw = response.Parameter?.Value;
      value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
    } catch (error) {
      if (errorName(error) !== 'ParameterNotFound') {
        // Not cached: the next question tries again.
        log('warn', 'air.key.readFailed', {errorName: errorName(error), timedOut: deadline.aborted});
        return undefined;
      }
      value = undefined;
    }
    log('info', 'air.key.read', {present: value !== undefined});
    cached = {value, at: now()};
    return value;
  };
}

export interface LambdaAirOptions {
  settings: AirSettings;
  log: VoiceLogger;
  now: () => number;
  fetch: AirFetch;
  /** Test seams: the SDK modules instead of the dynamic imports. */
  loadSsmSdk?: () => Promise<unknown>;
  loadGeoPlacesSdk?: () => Promise<unknown>;
  /** Test seam: the spending limits. */
  limits?: AirLimits;
}

/** The port for the Lambda, or undefined when AIR_QUALITY is off. Built on first use; see the module header. */
export function createLambdaAirQuality(options: LambdaAirOptions): AirQualityPort | undefined {
  const {settings, log, now} = options;
  if (!settings.enabled) return undefined;

  let building: Promise<AirQualityPort> | undefined;
  const build = async (): Promise<AirQualityPort> => {
    const started = now();
    const ssmModule: unknown = await (options.loadSsmSdk ?? (() => import(SSM_SDK_MODULE)))();
    if (!hasConstructor(ssmModule, 'SSM')) throw new Error(`${SSM_SDK_MODULE} does not export an SSM client`);
    const geoModule: unknown = await (options.loadGeoPlacesSdk ?? (() => import(GEO_PLACES_SDK_MODULE)))();
    if (!hasConstructor(geoModule, 'GeoPlaces')) {
      throw new Error(`${GEO_PLACES_SDK_MODULE} does not export a GeoPlaces client`);
    }
    const Ssm = (ssmModule as {SSM: new (config: typeof AIR_SDK_CLIENT_CONFIG) => SsmGetParameterClient}).SSM;
    const Places = (geoModule as {GeoPlaces: new (config: typeof AIR_SDK_CLIENT_CONFIG) => GeoPlacesClient}).GeoPlaces;
    const ssm = new Ssm(AIR_SDK_CLIENT_CONFIG);
    const places = new Places(AIR_SDK_CLIENT_CONFIG);
    const purpleAir = createPurpleAirClient({
      readKey: ssmReadKey(async () => ssm, now, log),
      fetch: options.fetch,
      log,
      now,
    });
    // The key read and type check start now, in the background, so the question that built the service waits for
    // them at most once (correctness recheck N6).
    void purpleAir.warm?.();
    const service = createAirQualityService({
      purpleAir,
      geocoder: createAwsGeocoder({client: async () => places, log, now}),
      ...(settings.home === undefined ? {} : {home: settings.home}),
      ...(settings.indoorSensorName === undefined ? {} : {indoorSensorName: settings.indoorSensorName}),
      ...(settings.indoorSensorIndex === undefined ? {} : {indoorSensorIndex: settings.indoorSensorIndex}),
      limits: options.limits ?? new AirLimits(now),
      now,
      log,
    });
    log('info', 'air.ready', {home: settings.home?.kind ?? 'none', ms: now() - started});
    return service;
  };
  const service = async (signal?: AbortSignal): Promise<AirQualityPort | undefined> => {
    building ??= build().catch((error: unknown) => {
      building = undefined;
      log('error', 'air.buildFailed', {
        problem: error instanceof Error ? error.message : 'unknown',
        errorName: errorName(error),
      });
      throw error;
    });
    try {
      return await (signal === undefined ? building : raceSignal(building, signal));
    } catch {
      return undefined;
    }
  };

  return {
    async lookupIndoor(context) {
      const port = await service(context?.signal);
      return port === undefined ? {kind: 'unavailable'} : port.lookupIndoor(context);
    },
    async lookupHere(device, context) {
      const port = await service(context?.signal);
      return port === undefined ? {used: 'none', result: {kind: 'unavailable'}} : port.lookupHere(device, context);
    },
    async lookupNamed(words, device, context) {
      const port = await service(context?.signal);
      return port === undefined
        ? {matched: 'none', result: {kind: 'unavailable'}}
        : port.lookupNamed(words, device, context);
    },
  };
}
