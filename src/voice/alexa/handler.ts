/**
 * The Alexa skill's Lambda handler (YA-14): envelope in, response out, with every outside effect injected.
 *
 * One request, in order:
 * 1. Parse the envelope and reject any application id that is not the configured skill, before anything else.
 * 2. Map it to a VoiceRequest. With no usable credential, a recognised voice is asked to link its own account and an
 *    unrecognised one is refused; neither touches a tracker, the core or the store.
 * 3. Look up the device's time zone once per session (at most 300 ms), then resolve the speaker's own tracker and run
 *    one core turn against a time budget. If the core is slow, send a progressive response; if it is slower still,
 *    abort the turn and answer honestly before Amazon's ~8 s limit. An aborted turn can no longer reach the tracker or
 *    save, and the store's conditional save stops a late write from erasing a newer one.
 * 4. Render the core's response, or a spoken, non-leaking message for a failure. A continuing session carries its
 *    pinned speaker key and time zone in `sessionAttributes`.
 *
 * Air quality (YA-36) needs no tracker. With no usable credential, `airQuality` (and the tracker-free `repeat`, `stop`
 * and `cancel`) still reach the core, with a tracker that refuses every call and a state record of their own
 * (`<key>:unlinked`), so nothing read through a link can be replayed. On an `airQuality` turn the handler first asks
 * the Device Address API for the device's country and postal code (at most 500 ms, alongside the time zone); refused
 * or failed, the core uses the home setting, and a refusal also sends the permission consent card, but only once the
 * owner has turned on ADDRESS_CONSENT_CARD after declaring the permission (review P2-11). An air-quality turn sends its
 * progressive response at 2.5 s, and hands the core its deadline.
 */
import type {
  AirQualityPort,
  Converse,
  DeviceLocation,
  IntentName,
  UserStateStore,
  VoiceIssueQuery,
  VoiceLogger,
  VoiceRequest,
  VoiceResponse,
  VoiceTracker,
} from '../core/types.ts';
import {
  COUNTRY_AND_POSTAL_CODE_SCOPE,
  describeConfig,
  DEVICE_ADDRESS_TIMEOUT_MS,
  MAX_TIMESTAMP_AGE_MS,
  PROGRESSIVE_SETTLE_MS,
  PROGRESSIVE_TIMEOUT_MS,
  TIME_ZONE_TIMEOUT_MS,
  type AlexaSkillConfig,
} from './config.ts';
import type {ProgressiveResponseBody, RequestEnvelope, ResponseEnvelope} from './envelope.ts';
import {idTag, REDACTED} from './log.ts';
import {MESSAGES} from './messages.ts';
import {
  applicationIds,
  InvalidEnvelopeError,
  mapRequest,
  parseRequestEnvelope,
  pinnedSpeaker,
  UnsupportedRequestError,
  type MappedRequest,
} from './request.ts';
import {adapterResponse, emptyResponse, renderResponse, renderSsml} from './response.ts';

/** Time, and timers that tests can drive by hand. */
export interface HandlerClock {
  now(): number;
  /** Calls `fire` once, `ms` from now. Returns a function that cancels it. */
  setTimer(ms: number, fire: () => void): () => void;
}

export const systemClock: HandlerClock = {
  now: () => Date.now(),
  setTimer: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

export interface FetchInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  /** Never follow a redirect: the Authorization header must not travel to another host. */
  redirect: 'error';
  signal: AbortSignal;
}

/** The part of `fetch` the Alexa API calls use. The global `fetch` satisfies it. */
export type FetchLike = (url: string, init: FetchInit) => Promise<{status: number; text(): Promise<string>}>;

/** What `trackerFor` learns about the turn it serves. */
export interface TrackerRequestOptions {
  /** Fires when the turn's deadline passes and the speaker has been answered without it. */
  signal: AbortSignal;
  /** Which link the token came from: the recognised person's own, or the Amazon account's. */
  linkedVia: 'person' | 'account';
  /** The platform request id, for logs. */
  requestId: string;
}

/** How a failed turn is spoken about. Nothing more specific ever reaches the speaker. */
export type FailureKind = 'unauthorized' | 'unavailable' | 'unknown';

/** The Lambda context fields the handler reads. */
export interface InvocationContext {
  awsRequestId?: string;
}

export interface HandlerDeps {
  config: AlexaSkillConfig;
  converse: Converse;
  /**
   * A tracker scoped to the account that issued this token (YA-15's binding). Called only with a usable token.
   * Must return a tracker bound to this token only; must not memoise across different tokens or keep the token beyond
   * the returned object; must not put the token in error messages. `options.signal` is the turn's deadline: once it
   * fires, requests still in flight should be aborted.
   */
  trackerFor: (accessToken: string, options: TrackerRequestOptions) => VoiceTracker;
  store: UserStateStore;
  log: VoiceLogger;
  clock: HandlerClock;
  fetch: FetchLike;
  /** Defaults to `classifyFailure`. YA-15 can pass one that knows its own error types. May throw; it is guarded. */
  classifyFailure?: (error: unknown) => FailureKind;
  /** The air-quality service (YA-36). Absent: the core says air quality is not set up. */
  airQuality?: AirQualityPort;
}

/** Intents that read no tracker, so they run without a linked account (YA-36). */
export const UNLINKED_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>([
  'airQuality',
  'airQualityPlace',
  'airQualityIndoor',
  'repeat',
  'stop',
  'cancel',
]);

/**
 * Also without a link, but only in a session whose last turn was an unlinked air-quality answer: "two", answering "Did
 * you mean Springfield, Illinois, or Springfield, Missouri?". Anywhere else an unlinked "open two" is refused as before.
 * Even so it reaches only the unlinked record, which never holds an issue list, and a tracker that refuses every call.
 */
export const UNLINKED_FOLLOW_UP_INTENTS: ReadonlySet<IntentName> = new Set<IntentName>(['open']);

/** On an air-quality turn, a progressive response goes out this early: a lookup chain can take seconds. */
export const AIR_PROGRESSIVE_AFTER_MS = 2500;

/** Appended to the speaker key of a turn with no usable credential, so it never shares a record with a linked one. */
export const UNLINKED_KEY_SUFFIX = ':unlinked';

/** What the Device Address API said, for logs and the consent card. */
export type DeviceAddressOutcome = 'located' | 'not-granted' | 'empty' | 'unavailable' | 'skipped';

/** Refuses every call: the tracker of a turn with no linked account, which only tracker-free intents reach. */
export class NotLinkedError extends Error {
  constructor(method: string) {
    super(`no linked account; refused ${method}`);
    this.name = 'NotLinkedError';
  }
}

const UNLINKED_TRACKER: VoiceTracker = {
  listIssues: () => Promise.reject(new NotLinkedError('listIssues')),
  getIssue: () => Promise.reject(new NotLinkedError('getIssue')),
  listComments: () => Promise.reject(new NotLinkedError('listComments')),
  listAssignees: () => Promise.reject(new NotLinkedError('listAssignees')),
};

export type AlexaHandler = (event: unknown, context?: InvocationContext) => Promise<ResponseEnvelope>;

/** The request names another skill. Thrown, so Lambda reports an error and Alexa plays nothing from this skill. */
export class ApplicationMismatchError extends Error {
  constructor() {
    super('request is not for this skill');
    this.name = 'ApplicationMismatchError';
  }
}

/** A tracker call or save attempted after the turn's deadline, when the speaker has already been answered. */
export class LateTurnError extends Error {
  readonly effect: string;

  constructor(effect: string) {
    super(`turn deadline passed; refused ${effect}`);
    this.name = 'LateTurnError';
    this.effect = effect;
  }
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const THROTTLING_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusOf(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : {};
  const status = [error.status, error.statusCode, response.status].find((value) => typeof value === 'number');
  return typeof status === 'number' ? status : undefined;
}

/** A short machine code from an error, safe for info logs: letters, digits, `_.-`, at most 64 characters. */
function errorCodeOf(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  for (const candidate of [error.code, error.kind]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A best guess from the shapes errors commonly take: an HTTP status on `status`, `statusCode` or `response.status`,
 * an abort, timeout or AWS throttling by name, or a Node network error code (also under `cause`, where `fetch` puts
 * it). 401 is `unauthorized`: the link has expired or was revoked, so relinking is the way back. 403 is not: the
 * account is linked but lacks permission, which relinking would not fix.
 */
export function classifyFailure(error: unknown): FailureKind {
  if (!isRecord(error)) return 'unknown';
  const status = statusOf(error);
  if (status === 401) return 'unauthorized';
  if (status !== undefined && (status === 408 || status === 429 || (status >= 500 && status <= 599))) {
    return 'unavailable';
  }
  if (typeof error.name === 'string') {
    if (error.name === 'AbortError' || error.name === 'TimeoutError' || THROTTLING_NAMES.has(error.name)) {
      return 'unavailable';
    }
  }
  const cause = isRecord(error.cause) ? error.cause : {};
  for (const code of [error.code, cause.code]) {
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return 'unavailable';
  }
  return 'unknown';
}

type TurnOutcome = {kind: 'answer'; response: VoiceResponse} | {kind: 'failed'; error: unknown} | {kind: 'timeout'};

interface TurnResult {
  outcome: TurnOutcome;
  /** The progressive-response POST, if one was started. */
  progressive?: Promise<void>;
}

/** Session attributes this adapter writes. Anything else Alexa echoes back is ignored. */
interface SkillSessionAttributes {
  /** The record this turn used and the tracker identity that read it (request.ts `PinnedSpeaker`). */
  speaker?: {key: string; identity: string};
  /** An IANA zone, or `null` once a lookup failed this session (so it is not retried). */
  timeZone?: string | null;
  /** The last turn was an unlinked air-quality answer, so a number may answer its place choice. */
  airFollowUp?: true;
}

const AWS_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The instant the budget counts from: Amazon's request timestamp when it is in the past by at most a minute (the
 * time already spent on a cold start or the network is charged to the budget), otherwise arrival, treating a larger
 * gap as clock skew.
 */
export function budgetBase(startedAt: number, timestamp: string): number {
  const stamped = Date.parse(timestamp);
  if (!Number.isFinite(stamped)) return startedAt;
  const age = startedAt - stamped;
  return age >= 0 && age <= MAX_TIMESTAMP_AGE_MS ? stamped : startedAt;
}

export function createHandler(deps: HandlerDeps): AlexaHandler {
  const {config, clock} = deps;
  const classify = deps.classifyFailure ?? classifyFailure;
  const safeClassify = (error: unknown): FailureKind => {
    try {
      return classify(error);
    } catch {
      return 'unknown';
    }
  };

  deps.log('info', 'alexa.config', describeConfig(config));

  return async (event, context) => {
    const startedAt = clock.now();
    const awsRequestId =
      typeof context?.awsRequestId === 'string' && AWS_REQUEST_ID.test(context.awsRequestId)
        ? context.awsRequestId
        : undefined;
    const log: VoiceLogger = (level, name, fields) => {
      deps.log(level, name, awsRequestId === undefined ? fields : {awsRequestId, ...fields});
    };

    let envelope: RequestEnvelope;
    try {
      envelope = parseRequestEnvelope(event);
    } catch (error) {
      if (error instanceof UnsupportedRequestError) {
        if (error.applicationIds.some((id) => id !== config.skillId)) {
          log('warn', 'alexa.application.rejected', {applicationTags: error.applicationIds.map(idTag)});
          throw new ApplicationMismatchError();
        }
        log('info', 'alexa.request.unsupported', {requestType: error.requestType});
        return emptyResponse();
      }
      log('warn', 'alexa.envelope.invalid', {
        problem: error instanceof InvalidEnvelopeError ? error.message : 'unknown',
      });
      throw error;
    }

    const ids = applicationIds(envelope);
    if (ids.some((id) => id !== config.skillId)) {
      log('warn', 'alexa.application.rejected', {
        requestId: envelope.request.requestId,
        applicationTags: ids.map(idTag),
      });
      throw new ApplicationMismatchError();
    }

    const mapped = mapRequest(envelope, config);
    logRequest(log, envelope, mapped);
    if (config.enrolmentLog && mapped.personId !== undefined) {
      // Runbook step 6: the only info line that carries an Amazon id, and only while ENROLMENT_LOG is on.
      log('info', 'alexa.enrolment.person', {requestId: mapped.voice.requestId, personId: mapped.personId});
    }
    const voice = mapped.voice;
    const base = budgetBase(startedAt, envelope.request.timestamp);
    const carried = carriedAttributes(envelope);

    if (voice.input.kind === 'sessionEnded') {
      if (mapped.accessToken) {
        if (typeof carried.timeZone === 'string') voice.timeZone = carried.timeZone;
        const {outcome} = await runTurn(
          mapped.accessToken,
          linkOf(mapped),
          voice,
          envelope,
          base,
          startedAt,
          false,
          log,
        );
        if (outcome.kind !== 'answer') logFailure(outcome, mapped, startedAt, envelope, log);
      }
      return emptyResponse();
    }

    const intent = voice.input.kind === 'intent' ? voice.input.intent : undefined;
    const airTurn = intent === 'airQuality';

    const unlinkedIntent =
      intent !== undefined &&
      (UNLINKED_INTENTS.has(intent) || (carried.airFollowUp === true && UNLINKED_FOLLOW_UP_INTENTS.has(intent)));
    if (!mapped.accessToken && unlinkedIntent) {
      voice.speaker = {...voice.speaker, userId: `${voice.speaker.userId}${UNLINKED_KEY_SUFFIX}`};
      log('info', 'alexa.link.notNeeded', {requestId: voice.requestId, intent});
      // The session's pin and time zone are carried through unchanged, so a linked turn after this one still finds the
      // list its listener heard (security review P3).
      const pin = pinnedSpeaker(envelope);
      const carriedOn: SkillSessionAttributes = {};
      if (pin !== undefined) carriedOn.speaker = pin;
      if (carried.timeZone !== undefined) carriedOn.timeZone = carried.timeZone;
      // Only the turn right after an air-quality answer may answer its choice (recheck N3): once "two" has been said,
      // or anything else, the mark is gone, and an unlinked number gets the usual refusal.
      if (airTurn) carriedOn.airFollowUp = true;
      const keepAttributes = (response: ResponseEnvelope): ResponseEnvelope =>
        Object.keys(carriedOn).length === 0 ? response : {...response, sessionAttributes: {...carriedOn}};
      if (base + config.answerByMs <= clock.now()) return keepAttributes(tooSlowResponse());
      const address = airTurn ? await resolveDeviceLocation(envelope, log) : undefined;
      if (address?.location !== undefined) voice.deviceLocation = address.location;
      const {outcome, progressive} = await runTurn(undefined, 'account', voice, envelope, base, startedAt, true, log);
      await settleProgressive(progressive, base);
      return finishTurn(outcome, mapped, envelope, startedAt, address?.outcome, log, keepAttributes);
    }

    if (!mapped.accessToken) {
      const mayLink = mapped.personId !== undefined || (config.accountTokenFallback && !mapped.accountTokenPresent);
      if (mayLink) {
        log('info', 'alexa.link.missing', {requestId: voice.requestId, personPresent: mapped.personId !== undefined});
        return adapterResponse(MESSAGES.linkAccount, {listen: false, linkAccountCard: true});
      }
      log('info', 'alexa.speaker.refused', {
        requestId: voice.requestId,
        personPresent: mapped.personId !== undefined,
        personMatched: mapped.personMatched,
        accountLinkPresent: mapped.accountTokenPresent,
      });
      return adapterResponse(MESSAGES.voiceNotRecognised, {listen: false});
    }

    const attributes: SkillSessionAttributes = {};
    if (mapped.trackerIdentity !== undefined) {
      attributes.speaker = {key: voice.speaker.userId, identity: mapped.trackerIdentity};
    }
    const withAttributes = (response: ResponseEnvelope): ResponseEnvelope => ({
      ...response,
      sessionAttributes: {...attributes},
    });

    if (base + config.answerByMs <= clock.now()) {
      log('error', 'alexa.turn.timeout', {
        requestId: voice.requestId,
        elapsedMs: clock.now() - startedAt,
        answerByMs: config.answerByMs,
        beforeStart: true,
      });
      return withAttributes(tooSlowResponse());
    }

    // In parallel (review P2-10): together they cost at most the longer of their two limits.
    const [timeZone, address] = await Promise.all([
      resolveTimeZone(envelope, carried, log),
      airTurn ? resolveDeviceLocation(envelope, log) : Promise.resolve(undefined),
    ]);
    attributes.timeZone = timeZone ?? null;
    if (timeZone !== undefined) voice.timeZone = timeZone;
    if (address?.location !== undefined) voice.deviceLocation = address.location;

    const {outcome, progressive} = await runTurn(
      mapped.accessToken,
      linkOf(mapped),
      voice,
      envelope,
      base,
      startedAt,
      true,
      log,
    );
    await settleProgressive(progressive, base);
    return finishTurn(outcome, mapped, envelope, startedAt, address?.outcome, log, withAttributes);
  };

  /** Renders a finished turn: the core's answer, or the adapter's words for a timeout or failure. */
  function finishTurn(
    outcome: TurnOutcome,
    mapped: MappedRequest,
    envelope: RequestEnvelope,
    startedAt: number,
    addressOutcome: DeviceAddressOutcome | undefined,
    log: VoiceLogger,
    withAttributes: (response: ResponseEnvelope) => ResponseEnvelope,
  ): ResponseEnvelope {
    const voice = mapped.voice;
    const elapsedMs = clock.now() - startedAt;

    if (outcome.kind === 'answer') {
      const rendered = renderResponse(outcome.response, voice.capabilities, {
        fallbackReprompt: MESSAGES.genericReprompt,
        cards: config.cards,
      });
      log('info', 'alexa.response', {
        requestId: voice.requestId,
        elapsedMs,
        listen: outcome.response.listen,
        segments: outcome.response.segments.length,
        earcon: outcome.response.earcon,
        card: rendered.envelope.response.card?.type,
      });
      if (rendered.cutSegments > 0) {
        log('warn', 'alexa.response.cut', {
          requestId: voice.requestId,
          cutSegments: rendered.cutSegments,
          cutChars: rendered.cutChars,
        });
      }
      if (rendered.repromptMissing) log('warn', 'alexa.response.repromptMissing', {requestId: voice.requestId});
      log('debug', 'alexa.response.speech', {
        requestId: voice.requestId,
        ssml: rendered.envelope.response.outputSpeech?.ssml,
      });
      if (addressOutcome === 'not-granted' && config.addressConsentCard === true) {
        // The listener was answered from home (or told how to ask); the Alexa app, if it shows cards, offers the grant.
        rendered.envelope.response.card = {
          type: 'AskForPermissionsConsent',
          permissions: [COUNTRY_AND_POSTAL_CODE_SCOPE],
        };
        log('info', 'alexa.address.consentCard', {requestId: voice.requestId});
      }
      return withAttributes(rendered.envelope);
    }

    const kind = logFailure(outcome, mapped, startedAt, envelope, log);
    switch (kind) {
      case 'timeout':
        return withAttributes(tooSlowResponse());
      case 'unauthorized':
        return withAttributes(
          adapterResponse(MESSAGES.relinkAccount, {listen: false, linkAccountCard: true, earcon: 'failure'}),
        );
      case 'unavailable':
        return withAttributes(adapterResponse(MESSAGES.trackerUnavailable, {listen: false, earcon: 'failure'}));
      default:
        return withAttributes(
          adapterResponse(MESSAGES.somethingWentWrong, {
            listen: true,
            reprompt: MESSAGES.genericReprompt,
            earcon: 'failure',
          }),
        );
    }
  }

  function tooSlowResponse(): ResponseEnvelope {
    return adapterResponse(MESSAGES.tooSlow, {listen: true, reprompt: MESSAGES.tooSlowReprompt, earcon: 'failure'});
  }

  /**
   * One core turn raced against the budget. When the deadline wins, the turn's AbortSignal fires first, and from then
   * on the turn's tracker calls and saves are refused (and logged), whatever the core does with the signal.
   */
  function runTurn(
    accessToken: string | undefined,
    linkedVia: TrackerRequestOptions['linkedVia'],
    voice: VoiceRequest,
    envelope: RequestEnvelope,
    base: number,
    startedAt: number,
    allowProgressive: boolean,
    log: VoiceLogger,
  ): Promise<TurnResult> {
    const controller = new AbortController();
    const requestId = voice.requestId;
    const refuse = (effect: string): Promise<never> => {
      log('warn', 'alexa.turn.lateEffectRefused', {requestId, effect});
      return Promise.reject(new LateTurnError(effect));
    };
    const guardTracker = (tracker: VoiceTracker): VoiceTracker => ({
      listIssues: (query: VoiceIssueQuery) =>
        controller.signal.aborted ? refuse('listIssues') : tracker.listIssues(query),
      getIssue: (key: string) => (controller.signal.aborted ? refuse('getIssue') : tracker.getIssue(key)),
      listComments: (key: string, limit: number) =>
        controller.signal.aborted ? refuse('listComments') : tracker.listComments(key, limit),
      listAssignees: (limit: number) =>
        controller.signal.aborted ? refuse('listAssignees') : tracker.listAssignees(limit),
    });
    const store: UserStateStore = {
      load: (userId) => deps.store.load(userId),
      save: (userId, serialized, expectedVersion) =>
        controller.signal.aborted ? refuse('save') : deps.store.save(userId, serialized, expectedVersion),
    };

    // An async wrapper, so a synchronous throw from trackerFor or converse becomes a failed turn, not a crash.
    const turn = (async () =>
      deps.converse(voice, {
        tracker: guardTracker(
          accessToken === undefined
            ? UNLINKED_TRACKER
            : deps.trackerFor(accessToken, {signal: controller.signal, linkedVia, requestId: voice.requestId}),
        ),
        store,
        policy: config.policy,
        now: () => clock.now(),
        log,
        signal: controller.signal,
        deadline: base + config.answerByMs,
        ...(deps.airQuality === undefined ? {} : {airQuality: deps.airQuality}),
      }))();

    let progressive: Promise<void> | undefined;
    const outcome = new Promise<TurnOutcome>((resolve) => {
      let settled = false;
      const cancels: Array<() => void> = [];
      const finish = (result: TurnOutcome) => {
        if (settled) return;
        settled = true;
        for (const cancel of cancels) cancel();
        if (result.kind === 'timeout') controller.abort();
        resolve(result);
      };

      turn.then(
        (response) => {
          if (settled) log('warn', 'alexa.turn.lateAnswer', {requestId, elapsedMs: clock.now() - startedAt});
          finish({kind: 'answer', response});
        },
        (error: unknown) => {
          if (settled) log('warn', 'alexa.turn.lateFailure', {requestId, failure: safeClassify(error)});
          finish({kind: 'failed', error});
        },
      );

      if (allowProgressive) {
        const after =
          voice.input.kind === 'intent' &&
          (voice.input.intent === 'airQuality' ||
            voice.input.intent === 'airQualityPlace' ||
            voice.input.intent === 'airQualityIndoor')
            ? Math.min(config.progressiveAfterMs, AIR_PROGRESSIVE_AFTER_MS)
            : config.progressiveAfterMs;
        const delay = Math.max(0, base + after - clock.now());
        cancels.push(
          clock.setTimer(delay, () => {
            if (!settled) progressive = sendProgressive(envelope, startedAt, log);
          }),
        );
      }
      const deadline = Math.max(0, base + config.answerByMs - clock.now());
      cancels.push(clock.setTimer(deadline, () => finish({kind: 'timeout'})));
    });
    return outcome.then((result) => (progressive ? {outcome: result, progressive} : {outcome: result}));
  }

  /** Waits for an in-flight progressive response for at most 300 ms, and never past the answer deadline. */
  async function settleProgressive(progressive: Promise<void> | undefined, base: number): Promise<void> {
    if (!progressive) return;
    const wait = Math.min(PROGRESSIVE_SETTLE_MS, Math.max(0, base + config.answerByMs - clock.now()));
    if (wait === 0) return;
    let cancel = () => {};
    await Promise.race([
      progressive,
      new Promise<void>((done) => {
        cancel = clock.setTimer(wait, done);
      }),
    ]);
    cancel();
  }

  /** Runs `call` with an abort after `ms`; resolves `undefined` if the timer wins, even if the call ignores the signal. */
  async function withTimeout<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    let cancel = () => {};
    const timedOut = new Promise<undefined>((done) => {
      cancel = clock.setTimer(ms, () => {
        controller.abort();
        done(undefined);
      });
    });
    try {
      return await Promise.race([call(controller.signal), timedOut]);
    } finally {
      cancel();
    }
  }

  /** Tells the speaker the skill is working. Failures are logged and swallowed: it is a courtesy, not the answer. */
  async function sendProgressive(envelope: RequestEnvelope, startedAt: number, log: VoiceLogger): Promise<void> {
    const requestId = envelope.request.requestId;
    const system = envelope.context.System;
    const endpoint = allowedEndpoint(system.apiEndpoint, config.apiEndpointHosts);
    if (!endpoint || !system.apiAccessToken) {
      log('warn', 'alexa.progressive.skipped', {
        requestId,
        reason: endpoint ? 'no api access token' : 'api endpoint not allowed',
      });
      return;
    }

    const body: ProgressiveResponseBody = {
      header: {requestId},
      // Sound-library audio is not allowed in progressive responses, so this carries speech only.
      directive: {
        type: 'VoicePlayer.Speak',
        speech: renderSsml([{text: MESSAGES.progressive}], {ratePercent: 100}).ssml,
      },
    };
    try {
      const result = await withTimeout(PROGRESSIVE_TIMEOUT_MS, (signal) =>
        deps.fetch(`${endpoint}/v1/directives`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${system.apiAccessToken}`, 'Content-Type': 'application/json'},
          body: JSON.stringify(body),
          redirect: 'error',
          signal,
        }),
      );
      if (result === undefined) {
        log('warn', 'alexa.progressive.failed', {requestId, errorName: 'TimeoutError'});
        return;
      }
      const fields = {requestId, status: result.status, elapsedMs: clock.now() - startedAt};
      if (result.status === 204) {
        log('info', 'alexa.progressive.sent', fields);
      } else {
        log('warn', 'alexa.progressive.rejected', fields);
      }
    } catch (error) {
      log('warn', 'alexa.progressive.failed', {requestId, errorName: error instanceof Error ? error.name : 'unknown'});
    }
  }

  /**
   * The device's IANA time zone from the Device Settings API, which needs no customer permission, fetched at most
   * once per session and carried in session attributes. Any failure leaves it out: the core then speaks absolute
   * dates. https://developer.amazon.com/en-US/docs/alexa/custom-skills/device-settings-api-reference.html
   */
  async function resolveTimeZone(
    envelope: RequestEnvelope,
    carried: SkillSessionAttributes,
    log: VoiceLogger,
  ): Promise<string | undefined> {
    const requestId = envelope.request.requestId;
    if (typeof carried.timeZone === 'string') return carried.timeZone;
    if (carried.timeZone === null) return undefined;

    const unavailable = (reason: string): undefined => {
      log('info', 'alexa.timeZone.unavailable', {requestId, reason});
      return undefined;
    };
    const system = envelope.context.System;
    const endpoint = allowedEndpoint(system.apiEndpoint, config.apiEndpointHosts);
    const deviceId = system.device?.deviceId;
    if (!endpoint || !system.apiAccessToken || typeof deviceId !== 'string' || deviceId === '') {
      return unavailable('no endpoint, api access token or device id');
    }

    const started = clock.now();
    try {
      const result = await withTimeout(TIME_ZONE_TIMEOUT_MS, async (signal) => {
        const response = await deps.fetch(
          `${endpoint}/v2/devices/${encodeURIComponent(deviceId)}/settings/System.timeZone`,
          {
            method: 'GET',
            headers: {Authorization: `Bearer ${system.apiAccessToken}`, Accept: 'application/json'},
            redirect: 'error',
            signal,
          },
        );
        return {status: response.status, body: response.status === 200 ? await response.text() : ''};
      });
      if (result === undefined) return unavailable('timeout');
      if (result.status !== 200) return unavailable(`status ${result.status}`);
      const zone = parseTimeZone(result.body);
      if (zone === undefined) return unavailable('unrecognised zone');
      log('info', 'alexa.timeZone.resolved', {requestId, elapsedMs: clock.now() - started});
      log('debug', 'alexa.timeZone.detail', {requestId, timeZone: zone});
      return zone;
    } catch (error) {
      return unavailable(error instanceof Error ? error.name : 'unknown');
    }
  }

  /**
   * The device's country and postal code from the Device Address API, for an air-quality turn. Never the street
   * address: only the country-and-postal-code call is made, and it needs only that permission. The values are logged
   * at debug only. Any failure leaves the location out, and the core falls back to the home setting.
   */
  async function resolveDeviceLocation(
    envelope: RequestEnvelope,
    log: VoiceLogger,
  ): Promise<{outcome: DeviceAddressOutcome; location?: DeviceLocation}> {
    const requestId = envelope.request.requestId;
    const system = envelope.context.System;
    const endpoint = allowedEndpoint(system.apiEndpoint, config.apiEndpointHosts);
    const deviceId = system.device?.deviceId;
    const started = clock.now();
    const done = (outcome: DeviceAddressOutcome, fields: Record<string, unknown> = {}) => {
      log('info', 'alexa.address', {requestId, outcome, elapsedMs: clock.now() - started, ...fields});
      return {outcome};
    };
    if (!endpoint || !system.apiAccessToken || typeof deviceId !== 'string' || deviceId === '') {
      return done('skipped', {reason: endpoint ? 'no api access token or device id' : 'api endpoint not allowed'});
    }
    try {
      const result = await withTimeout(DEVICE_ADDRESS_TIMEOUT_MS, async (signal) => {
        const response = await deps.fetch(
          `${endpoint}/v1/devices/${encodeURIComponent(deviceId)}/settings/address/countryAndPostalCode`,
          {
            method: 'GET',
            headers: {Authorization: `Bearer ${system.apiAccessToken}`, Accept: 'application/json'},
            redirect: 'error',
            signal,
          },
        );
        return {status: response.status, body: response.status === 200 ? await response.text() : ''};
      });
      if (result === undefined) return done('unavailable', {reason: 'timeout'});
      if (result.status === 403) return done('not-granted', {status: 403});
      if (result.status === 204) return done('empty', {status: 204});
      if (result.status !== 200) return done('unavailable', {status: result.status});
      const location = parseCountryAndPostalCode(result.body);
      if (location === undefined) return done('empty', {status: 200, reason: 'no usable postal code'});
      log('debug', 'alexa.address.detail', {
        requestId,
        countryCode: location.countryCode,
        postalCode: location.postalCode,
      });
      return {...done('located', {status: 200, countryCode: location.countryCode}), location};
    } catch (error) {
      return done('unavailable', {errorName: error instanceof Error ? error.name : 'unknown'});
    }
  }

  function logFailure(
    outcome: Exclude<TurnOutcome, {kind: 'answer'}>,
    mapped: MappedRequest,
    startedAt: number,
    envelope: RequestEnvelope,
    log: VoiceLogger,
  ): FailureKind | 'timeout' {
    const requestId = mapped.voice.requestId;
    const elapsedMs = clock.now() - startedAt;
    if (outcome.kind === 'timeout') {
      log('error', 'alexa.turn.timeout', {requestId, elapsedMs, answerByMs: config.answerByMs});
      return 'timeout';
    }
    const kind = safeClassify(outcome.error);
    const error = outcome.error;
    log('error', 'alexa.turn.failed', {
      requestId,
      elapsedMs,
      failure: kind,
      errorName: error instanceof Error ? error.name : typeof error,
      status: statusOf(error),
      errorCode: errorCodeOf(error),
    });
    // An error's message can carry tracker content or a URL, so it is content; a credential in it is redacted.
    const message = error instanceof Error ? error.message : String(error);
    log('debug', 'alexa.turn.failed.detail', {
      requestId,
      message: redactCredentials(message, [mapped.accessToken, envelope.context.System.apiAccessToken]),
    });
    return kind;
  }
}

/** The link a usable token came from. `mapRequest` sets `tokenSource` to `none` only when there is no token. */
function linkOf(mapped: MappedRequest): TrackerRequestOptions['linkedVia'] {
  return mapped.tokenSource === 'person' ? 'person' : 'account';
}

/** Replaces every known credential, and anything shaped like a bearer token, with `[redacted]`. */
export function redactCredentials(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret !== '') out = out.split(secret).join(REDACTED);
  }
  return out.replace(/Bearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`);
}

/**
 * `{"countryCode": "US", "postalCode": "59802"}` as a DeviceLocation, or undefined. A country code is two letters; a
 * postal code is letters, digits, spaces and hyphens, at most 12 characters. Anything else is not used.
 */
export function parseCountryAndPostalCode(body: string): DeviceLocation | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const countryCode = typeof value.countryCode === 'string' ? value.countryCode.trim().toUpperCase() : '';
  const postalCode = typeof value.postalCode === 'string' ? value.postalCode.trim() : '';
  if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/.test(postalCode)) return undefined;
  return {countryCode, postalCode};
}

/** A JSON string naming a zone the runtime knows, e.g. `"Europe/London"`; bare text is accepted too. */
export function parseTimeZone(body: string): string | undefined {
  let value: unknown = body.trim();
  try {
    value = JSON.parse(body);
  } catch {
    // Not JSON: keep the trimmed text.
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: value});
    return value;
  } catch {
    return undefined;
  }
}

function carriedAttributes(envelope: RequestEnvelope): SkillSessionAttributes {
  const attributes = envelope.session?.new === false ? envelope.session.attributes : undefined;
  if (!isRecord(attributes)) return {};
  const carried: SkillSessionAttributes = attributes.airFollowUp === true ? {airFollowUp: true} : {};
  const zone = attributes.timeZone;
  if (zone === null) return {...carried, timeZone: null};
  if (typeof zone === 'string' && parseTimeZone(JSON.stringify(zone)) !== undefined)
    return {...carried, timeZone: zone};
  return carried;
}

/** The endpoint's origin if it is HTTPS on an allowed host with no path tricks, otherwise undefined. */
export function allowedEndpoint(apiEndpoint: string | undefined, hosts: readonly string[]): string | undefined {
  if (!apiEndpoint) return undefined;
  let url: URL;
  try {
    url = new URL(apiEndpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return undefined;
  return hosts.includes(url.hostname) ? url.origin : undefined;
}

/** Amazon's session-end error type is an upper-case enum (`INVALID_RESPONSE`); anything else is not logged at info. */
export function errorTypeOf(type: unknown): string | undefined {
  return typeof type === 'string' && /^[A-Z_]{1,64}$/.test(type) ? type : undefined;
}

function logRequest(log: VoiceLogger, envelope: RequestEnvelope, mapped: MappedRequest): void {
  const voice = mapped.voice;
  const input = voice.input;
  const request = envelope.request;
  log('info', 'alexa.request', {
    requestId: voice.requestId,
    requestType: request.type,
    alexaIntent: mapped.alexaIntent,
    input: input.kind,
    intent: input.kind === 'intent' ? input.intent : undefined,
    slotNames: input.kind === 'intent' ? Object.keys(input.slots) : undefined,
    locale: voice.locale,
    evidence: voice.speaker.evidence,
    personPresent: mapped.personId !== undefined,
    personMatched: mapped.personMatched,
    linkedVia: mapped.tokenSource,
    accountLinkPresent: mapped.accountTokenPresent,
    speakerKey: mapped.keyChoice,
    speakerTag: idTag(voice.speaker.userId),
    display: voice.capabilities.display,
    newSession: envelope.session?.new,
    sessionEndReason: request.type === 'SessionEndedRequest' ? request.reason : undefined,
    sessionEndErrorType: request.type === 'SessionEndedRequest' ? errorTypeOf(request.error?.type) : undefined,
  });
  // Raw Amazon ids, what was said and Amazon's error text are content.
  log('debug', 'alexa.request.detail', {
    requestId: voice.requestId,
    userId: voice.speaker.userId,
    personId: mapped.personId,
    slots: input.kind === 'intent' ? input.slots : undefined,
    sessionEndErrorMessage: request.type === 'SessionEndedRequest' ? request.error?.message : undefined,
  });
}
