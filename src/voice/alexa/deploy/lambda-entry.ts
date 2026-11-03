/**
 * The full Lambda entry (YA-15, from the YA-14 judgement B4): `createHandler` with YA-13's `converse`, the YouTrack
 * binding's `trackerFor`, the DynamoDB state store, the JSON logger and the system clock. Handler path
 * `voice/alexa/deploy/lambda-entry.handler`; built like the hello entry (docs/voice/alexa.md, runbook step 2).
 *
 * Environment: everything `configFromEnvironment` reads (SKILL_ID, READ_ACCEPTS, ...), plus STATE_TABLE (required),
 * STATE_TTL_DAYS (default 90), LOG_LEVEL (default info), YOUTRACK_URL (required), YOUTRACK_PROJECT (default H) and
 * HOUSEHOLD_LOGIN (required with ACCOUNT_TOKEN_FALLBACK=true: an account-level link to any other login reads nothing).
 * No token is configured here: each request's token arrives through account linking.
 *
 * Air quality (YA-36): AIR_QUALITY (on/off, default off) and HOME_LOCATION (empty, "lat,lon" or a place name). With it
 * on, the service is built on the first air-quality question (src/voice/air/aws.ts): the PurpleAir key from SSM, never
 * from the environment.
 *
 * The DynamoDB SDK. `@aws-sdk/client-dynamodb` ships in the Lambda Node.js runtime but is not a dependency of this
 * repository, so it is imported dynamically, by a specifier held in a variable (the typecheck never resolves it), and
 * checked at runtime against the one constructor `dynamo-store.ts` needs. Nothing is imported at module load:
 * the first invocation builds the handler, and a failed build is logged, thrown, and tried again on the next one.
 */
import {TrackerFailure} from '../../../tracker.ts';
import {bindingSettings, createYouTrackBinding, LinkMismatchError} from '../../binding/youtrack.ts';
import {converse} from '../../core/converse.ts';
import type {Converse, VoiceTracker} from '../../core/types.ts';
import {configFromEnvironment} from '../config.ts';
import {createDynamoStore, type DynamoItemClient} from '../dynamo-store.ts';
import {
  classifyFailure,
  createHandler,
  systemClock,
  type AlexaHandler,
  type FailureKind,
  type HandlerClock,
  type TrackerRequestOptions,
} from '../handler.ts';
import {createJsonLogger, parseLogLevel} from '../log.ts';
import {airSettings, createLambdaAirQuality} from '../../air/aws.ts';

/** Held in a variable so TypeScript does not try to resolve a module this repository does not install. */
export const DYNAMO_SDK_MODULE = '@aws-sdk/client-dynamodb';

/**
 * At most two attempts (one retry), a second to answer and half a second to connect, so a slow table costs a turn at
 * most a few seconds of its 7 s budget. `requestHandler` as plain options is accepted by SDK v3 releases since 3.521.
 */
export const DYNAMO_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: {requestTimeout: 1000, connectionTimeout: 500},
} as const;

/** The part of the SDK module the entry uses: the aggregated client, whose methods return promises. */
interface DynamoSdk {
  DynamoDB: new (config: typeof DYNAMO_CLIENT_CONFIG) => DynamoItemClient;
}

function isDynamoSdk(value: unknown): value is DynamoSdk {
  return typeof value === 'object' && value !== null && typeof (value as {DynamoDB?: unknown}).DynamoDB === 'function';
}

export const DEFAULT_STATE_TTL_DAYS = 90;

/**
 * How a failed turn is spoken: a link to the wrong YouTrack account, or a 401 while checking the link, is "relink";
 * a tracker that could not be reached is "unavailable"; anything else as the handler classifies it. Never throws.
 */
export function classifyEntryFailure(error: unknown): FailureKind {
  if (error instanceof LinkMismatchError) return 'unauthorized';
  if (error instanceof TrackerFailure && error.kind === 'unavailable') return 'unavailable';
  return classifyFailure(error);
}

/** STATE_TTL_DAYS as seconds: a whole number of days from 1 to 365, 90 when unset. */
export function stateTtlSeconds(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.STATE_TTL_DAYS?.trim();
  const days = raw === undefined || raw === '' ? DEFAULT_STATE_TTL_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('STATE_TTL_DAYS must be a whole number of days from 1 to 365');
  }
  return days * 24 * 60 * 60;
}

export interface LambdaEntryOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Where log lines go; stdout (CloudWatch Logs) by default. */
  write?: (line: string) => void;
  /** Test seam: the SDK module, instead of the dynamic import. */
  loadDynamoSdk?: () => Promise<unknown>;
  /** Test seam: a ready client, instead of the SDK. */
  dynamo?: DynamoItemClient;
  /** Test seam: a tracker per token, instead of the YouTrack binding (and its link check). */
  trackerFor?: (accessToken: string, options: TrackerRequestOptions) => VoiceTracker;
  /** Test seam: the fetch for YouTrack, the Alexa APIs and PurpleAir. */
  fetch?: typeof fetch;
  /** Test seams: the SDK modules the air-quality service imports on first use. */
  loadSsmSdk?: () => Promise<unknown>;
  loadGeoPlacesSdk?: () => Promise<unknown>;
  clock?: HandlerClock;
}

/** Builds the handler. Throws, after logging why, if the environment is misconfigured or the SDK is missing. */
export async function createLambdaHandler(options: LambdaEntryOptions): Promise<AlexaHandler> {
  const {env} = options;
  const clock = options.clock ?? systemClock;
  const log = createJsonLogger({
    level: parseLogLevel(env.LOG_LEVEL, 'info'),
    now: () => clock.now(),
    ...(options.write ? {write: options.write} : {}),
  });
  const started = clock.now();
  const fetcher = options.fetch ?? globalThis.fetch;

  try {
    const config = configFromEnvironment(env);
    const tableName = env.STATE_TABLE?.trim();
    if (!tableName) throw new Error('STATE_TABLE is required');
    const ttlSeconds = stateTtlSeconds(env);
    const air = airSettings(env, log);
    let trackerFor: (accessToken: string, options: TrackerRequestOptions) => VoiceTracker;
    let turn: Converse = converse;
    if (options.trackerFor !== undefined) {
      trackerFor = options.trackerFor;
    } else {
      const settings = bindingSettings(env);
      if (config.accountTokenFallback && settings.householdLogin === undefined) {
        // Without it, whatever account the Amazon account happened to link would serve every unrecognised voice.
        throw new Error('HOUSEHOLD_LOGIN is required when ACCOUNT_TOKEN_FALLBACK=true');
      }
      const binding = createYouTrackBinding({settings, log, fetch: fetcher, now: () => clock.now()});
      // The link check starts when the handler asks for the turn's tracker, and the turn waits for it before the core
      // runs, so a link to the wrong account fails the turn (spoken as "relink") before anything is read. Keyed by the
      // platform request id; each entry lives only from trackerFor to the converse call that follows it.
      const checks = new Map<string, Promise<void>>();
      trackerFor = (accessToken, request) => {
        const check = binding.checkLink(accessToken, request);
        check.catch(() => {
          // Awaited by the turn below; this only keeps an unawaited rejection from being reported as unhandled.
        });
        checks.set(request.requestId, check);
        return binding.trackerFor(accessToken, request);
      };
      turn = async (request, deps) => {
        const check = checks.get(request.requestId);
        checks.delete(request.requestId);
        if (check !== undefined) await check;
        return converse(request, deps);
      };
    }

    let client = options.dynamo;
    if (client === undefined) {
      const sdk: unknown = await (options.loadDynamoSdk ?? (() => import(DYNAMO_SDK_MODULE)))();
      if (!isDynamoSdk(sdk)) throw new Error(`${DYNAMO_SDK_MODULE} does not export a DynamoDB client`);
      client = new sdk.DynamoDB(DYNAMO_CLIENT_CONFIG);
    }
    const store = createDynamoStore({client, tableName, ttlSeconds, now: () => clock.now()});

    const airQuality = createLambdaAirQuality({
      settings: air,
      log,
      now: () => clock.now(),
      fetch: fetcher,
      ...(options.loadSsmSdk === undefined ? {} : {loadSsmSdk: options.loadSsmSdk}),
      ...(options.loadGeoPlacesSdk === undefined ? {} : {loadGeoPlacesSdk: options.loadGeoPlacesSdk}),
    });
    const handler = createHandler({
      config,
      converse: turn,
      trackerFor,
      store,
      log,
      clock,
      fetch: fetcher,
      classifyFailure: classifyEntryFailure,
      ...(airQuality === undefined ? {} : {airQuality}),
    });
    log('info', 'alexa.entry.ready', {
      stateTtlDays: ttlSeconds / 86_400,
      dynamo: options.dynamo === undefined ? 'sdk' : 'injected',
      tracker: options.trackerFor === undefined ? 'youtrack' : 'injected',
      airQuality: air.enabled,
      homeLocation: air.home?.kind ?? 'none',
      ms: clock.now() - started,
    });
    return handler;
  } catch (error) {
    // Config errors name variables and kinds, not values; an import failure names the module.
    log('error', 'alexa.entry.startFailed', {
      problem: error instanceof Error ? error.message : 'unknown',
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

let ready: Promise<AlexaHandler> | undefined;

/** The Lambda entry point: `voice/alexa/deploy/lambda-entry.handler`. Built on the first invocation, then reused. */
export const handler: AlexaHandler = async (event, context) => {
  ready ??= createLambdaHandler({env: process.env}).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return (await ready)(event, context);
};
