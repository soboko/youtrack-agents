/**
 * The OAuth link broker (YA-33): an authorization server in front of YouTrack for the Alexa skill's account linking,
 * plus owner-initiated app-to-app linking through Amazon's Skill Enablement API. A pure handler for Lambda Function
 * URL events; every effect (clock, randomness, network, table, secrets, logs) is injected.
 *
 * Why it exists (YA-14): the Alexa iOS app cannot start linking for this skill, and YouTrack's Hub enforces PKCE on the
 * authorization request while Amazon's server-side code exchange sends no `code_verifier`. The broker holds its own
 * PKCE verifier and the YouTrack client secret, and hands Amazon a one-time code of its own instead.
 *
 * Routes:
 *   GET  /start?k=<key>      owner-initiated linking; needs the setup key; goes to Login with Amazon first
 *   GET  /amazon-callback    Login with Amazon's redirect back: token exchange, then YouTrack authorization
 *   GET  /youtrack-callback  YouTrack's redirect back: code exchange, household check, then Alexa or the Enablement API
 *   POST /token              the skill's Access Token URI: the one-time code, or a refresh proxied to YouTrack
 *   GET  /authorize          the skill's Web Authorization URI (Alexa-initiated linking); off unless
 *                            LINK_BROKER_AUTHORIZE=on, because app-to-app linking never needs it (security review S1)
 *
 * Why Amazon comes first (correctness review C1). Hub issues a refresh token only the first time it exchanges a code
 * for a user (https://www.jetbrains.com/help/youtrack/devportal/Authorization-Code.html). A failure after that exchange
 * spends the household's one refresh token, and every retry then gets none until an administrator removes it. So the
 * YouTrack exchange is the last step before the Enablement API redeems the broker code, and every page that can follow
 * it says how to recover.
 *
 * Record kinds in the link table, each keyed and sealed by a value only the flow holds (crypto.ts):
 *   `lwa`    a Login with Amazon authorization in progress (10 min): the broker's PKCE verifier toward Amazon.
 *   `state`  a YouTrack authorization in progress (10 min): the broker's PKCE verifier, and where to continue:
 *            back to Alexa (with Alexa's state) or on to the Enablement API (with the customer's Amazon token).
 *   `code`   a one-time broker code (5 min): the YouTrack tokens, the redirect URI and any Alexa PKCE challenge.
 */
import type {VoiceLogger} from '../core/types.ts';
import {alexaRedirectUrls, FUNCTION_URL_HOST, type BrokerSettings} from './config.ts';
import {
  constantTimeEqual,
  flowTag,
  isPkceVerifier,
  isS256Challenge,
  open,
  randomToken,
  recordId,
  s256Challenge,
  seal,
  type RandomBytes,
} from './crypto.ts';
import {
  BadRequestError,
  basicCredentials,
  bodyText,
  header,
  json,
  page,
  pageWithDetail,
  parseParams,
  queryOf,
  redirect,
  type FunctionUrlEvent,
  type FunctionUrlResult,
  type Params,
} from './http.ts';
import {setupKeyUsable, type LwaClient, type SetupSecrets, type TokenSecrets} from './secrets.ts';
import type {LinkStore} from './store.ts';

/** RFC 6749 section 10.12 and the brief: a flow's `state` lives ten minutes. */
export const STATE_TTL_SECONDS = 600;

/** RFC 6749 section 4.1.2 recommends at most ten minutes for a code; the brief sets five. */
export const CODE_TTL_SECONDS = 300;

/** How long one upstream request (YouTrack, Login with Amazon) may take, outside `/token`. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;

/**
 * Amazon expects the Access Token URI to answer "within 4.5 seconds"
 * (https://developer.amazon.com/en-US/docs/alexa/account-linking/requirements-account-linking.html). A refresh is
 * answered within this many milliseconds of the invocation's start, which leaves half a second for Lambda and the
 * network. The YouTrack call gets whatever remains of it, not a fixed timeout.
 */
export const DEFAULT_TOKEN_BUDGET_MS = 4000;

/** Below this much remaining budget the refresh is not attempted: Amazon would give up before Hub answered. */
export const MIN_REFRESH_UPSTREAM_MS = 300;

/**
 * The Skill Enablement API call waits while Amazon redeems the broker code at `/token`, so it gets longer. The
 * function's timeout (template.yaml) is above this plus the YouTrack exchange and login check before it.
 */
export const DEFAULT_ENABLEMENT_TIMEOUT_MS = 9000;

/**
 * Login with Amazon, North America (the household's marketplace). For app-to-app linking the client is not a separate
 * LWA security profile: it is the "Alexa Client ID" and "Alexa Client Secret" the developer console shows once app-to-app
 * linking is turned on, and the console's "Your Redirect URLs" must hold the broker's `/amazon-callback`.
 * https://developer.amazon.com/en-US/docs/alexa/account-linking/app-to-app-account-linking-starting-from-your-app.html
 */
export const LWA_AUTHORIZE_URL = 'https://www.amazon.com/ap/oa';
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/** The scope the Skill Enablement API needs on the customer's Login with Amazon token. */
export const LWA_ACCOUNT_LINKING_SCOPE = 'alexa::skills:account_linking';

/** The runbook section every "spent refresh token" page points at. */
export const RECOVERY_SECTION = 'Recover a spent YouTrack refresh token';

/**
 * Shown on every page after YouTrack may have issued the household's refresh token and the link did not complete.
 * Hub gives this client a refresh token only on an account's first authorisation, so a retry needs it removed first.
 */
export const RECOVERY_TEXT: readonly string[] = [
  "Before trying again, the household account's YouTrack refresh token for the Alexa voice client must be removed: " +
    'YouTrack issues that token only the first time an account authorises the client, so a retry would get none.',
  `A YouTrack administrator removes it with the Hub REST call in the runbook, section "${RECOVERY_SECTION}" ` +
    '(docs/voice/alexa.md). Then open a new setup link.',
];

/** The longest Alexa `state` accepted. Alexa's are far shorter; this only bounds what is sealed and echoed. */
const MAX_ALEXA_STATE_LENGTH = 1024;

/** The most of an upstream error body shown on a page. */
const MAX_DETAIL_LENGTH = 2000;

/** An OAuth error code as RFC 6749 defines them (section 5.2): shown and logged only when it matches. */
const ERROR_CODE = /^[a-z_]{1,64}$/;

/** An Amazon status word (`LINKED`, `ENABLED`): shown and logged only when it matches. */
const STATUS_WORD = /^[A-Z_]{1,40}$/;

export interface BrokerClock {
  now(): number;
}

export interface LinkBrokerDeps {
  settings: BrokerSettings;
  /** Read once at init: what `/token` needs. */
  secrets: TokenSecrets;
  /** Read per request: what `/start` and `/amazon-callback` need. */
  setupSecrets: SetupSecrets;
  store: LinkStore;
  fetch: typeof fetch;
  clock: BrokerClock;
  random: RandomBytes;
  log: VoiceLogger;
  upstreamTimeoutMs?: number;
  enablementTimeoutMs?: number;
  tokenBudgetMs?: number;
  /** The abort signal for an upstream call of `ms` milliseconds; `AbortSignal.timeout` by default. A test seam. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export interface LinkRequestContext {
  /** When the invocation started (epoch ms), before any cold build; `/token`'s budget counts from here. */
  startedAt?: number;
}

export type LinkBrokerHandler = (event: FunctionUrlEvent, context?: LinkRequestContext) => Promise<FunctionUrlResult>;

/** The YouTrack tokens as the broker keeps them between steps. */
interface YouTrackTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn?: number;
}

/** Where a YouTrack authorization continues: back to Alexa with a code, or on to the Enablement API. */
type FlowStart =
  | {flow: 'alexa'; alexaRedirectUri: string; alexaState: string; alexaChallenge?: string}
  | {flow: 'app'; amazonToken: string};

type StateFlow = FlowStart & {v: 1; verifier: string};

interface LwaFlow {
  v: 1;
  /** The broker's PKCE verifier toward Login with Amazon (optional there, used anyway). */
  verifier: string;
}

interface CodeGrant {
  v: 1;
  redirectUri: string;
  challenge?: string;
  tokens: YouTrackTokens;
}

type Kind = 'state' | 'lwa' | 'code';

/** A failure already turned into the response to send; thrown from deep inside a route to end it. */
class Respond extends Error {
  readonly result: FunctionUrlResult;

  constructor(result: FunctionUrlResult) {
    super('respond');
    this.name = 'Respond';
    this.result = result;
  }
}

/** Every path the broker answers; anything else is a plain 404. */
const ROUTES: readonly string[] = ['/authorize', '/start', '/youtrack-callback', '/amazon-callback', '/token'];

const EXPIRED_PAGE_TEXT = [
  'This sign-in link has expired or has already been used.',
  'Nothing was linked. Start again from the beginning.',
];

/**
 * Removes every sensitive value this request has seen, and anything shaped like an Amazon token, client secret or
 * bearer credential, from text about to be shown or logged.
 */
export class Scrubber {
  private readonly values = new Set<string>();

  add(...values: readonly (string | undefined)[]): void {
    for (const value of values) {
      if (value !== undefined && value.length >= 6) this.values.add(value);
    }
  }

  scrub(text: string): string {
    let out = text;
    // Longest first, so a value containing another is removed whole.
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join('[redacted]');
      const encoded = encodeURIComponent(value);
      if (encoded !== value) out = out.split(encoded).join('[redacted]');
    }
    return out
      .replace(/Atz[a-z]\|[^\s"',}&]+/g, '[redacted]')
      .replace(/amzn1\.oa2-cs\.v1\.[A-Za-z0-9]+/g, '[redacted]')
      .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [redacted]');
  }
}

function errorCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as {error?: unknown}).error;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * The provider's `error_description`, reduced to a short run of plain words so it can be logged and shown: Hub's
 * descriptions ("Unknown authorization code", "Redirect URI mismatch") name the cause, and nothing in them is secret.
 * Anything outside letters, digits, spaces and basic punctuation is dropped, and long token-like runs are removed.
 */
function errorDescriptionOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as {error_description?: unknown}).error_description;
  if (typeof raw !== 'string') return undefined;
  const plain = raw
    .replace(/[^A-Za-z0-9 .,:;'()_-]/g, ' ')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return plain === '' ? undefined : plain;
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/** HTTP Basic client authentication as RFC 6749 section 2.3.1 specifies it (each part form-urlencoded first). */
function basicHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, 'utf8').toString('base64')}`;
}

function parseTokens(value: unknown): YouTrackTokens | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const body = value as Record<string, unknown>;
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  const tokens: YouTrackTokens = {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : '',
    tokenType: typeof body.token_type === 'string' && body.token_type !== '' ? body.token_type : 'Bearer',
  };
  const expiresIn = Number(body.expires_in);
  if (Number.isInteger(expiresIn) && expiresIn > 0) tokens.expiresIn = expiresIn;
  return tokens;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

export function createLinkBroker(deps: LinkBrokerDeps): LinkBrokerHandler {
  const {settings, secrets, setupSecrets, store, clock, random, log} = deps;
  const upstreamTimeoutMs = deps.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const enablementTimeoutMs = deps.enablementTimeoutMs ?? DEFAULT_ENABLEMENT_TIMEOUT_MS;
  const tokenBudgetMs = deps.tokenBudgetMs ?? DEFAULT_TOKEN_BUDGET_MS;
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const allowedAlexaRedirects = alexaRedirectUrls(settings.vendorId);
  const hubUrl = `${settings.youtrackUrl}/hub/api/rest/oauth2`;
  // One broker per execution environment (deploy/entry.ts), so its first request is the environment's first.
  let served = 0;

  const nowSeconds = (): number => Math.floor(clock.now() / 1000);

  const call = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> =>
    deps.fetch(url, {...init, redirect: 'error', signal: timeoutSignal(timeoutMs)});

  const sealAndPut = async (kind: Kind, secret: string, payload: object, ttlSeconds: number): Promise<void> => {
    await store.put(recordId(kind, secret), {
      sealed: seal(kind, secret, JSON.stringify(payload), random),
      expiresAt: nowSeconds() + ttlSeconds,
    });
  };

  /** Deletes and opens a record. Null when it is absent, expired, already taken, or does not verify. */
  const takeAndOpen = async <T>(kind: Kind, secret: string): Promise<T | null> => {
    const record = await store.take(recordId(kind, secret));
    if (record === null) return null;
    const text = open(kind, secret, record.sealed);
    if (text === null) return null;
    const payload = parseJson(text) as {v?: unknown} | undefined;
    return payload?.v === 1 ? (payload as T) : null;
  };

  const originOf = (event: FunctionUrlEvent): string | undefined => {
    const domain = event.requestContext?.domainName ?? '';
    const origin = `https://${domain}`;
    if (settings.brokerOrigin !== undefined) return origin === settings.brokerOrigin ? origin : undefined;
    return FUNCTION_URL_HOST.test(domain) ? origin : undefined;
  };

  const notConfigured = (reason: string): FunctionUrlResult => {
    log('warn', 'link.setup.notConfigured', {reason});
    return page(503, 'Setup linking is not configured', [
      'The Login with Amazon client is not in SSM. Nothing was linked; see the runbook, step 4.',
    ]);
  };

  /** Starts the YouTrack leg with the broker's own PKCE: stores the verifier under a fresh state and redirects. */
  const startYouTrack = async (flow: FlowStart, origin: string): Promise<FunctionUrlResult> => {
    const state = randomToken(random);
    const verifier = randomToken(random);
    await sealAndPut('state', state, {...flow, v: 1, verifier}, STATE_TTL_SECONDS);
    const url = new URL(`${hubUrl}/auth`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.youtrackClientId);
    url.searchParams.set('redirect_uri', `${origin}/youtrack-callback`);
    url.searchParams.set('scope', settings.youtrackScope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', s256Challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    // "logs out user and shows login form": a browser signed in to YouTrack as someone else cannot link that someone.
    url.searchParams.set('request_credentials', 'required');
    log('info', 'link.youtrack.authorizeStarted', {flow: flow.flow, flowTag: flowTag('state', state)});
    return redirect(url.toString());
  };

  /**
   * Tokens YouTrack issued that the broker will not hand on are dropped, never stored. Hub has no OAuth revocation
   * endpoint (only an administrator's REST call to remove a user's refresh token), so the broker cannot revoke them;
   * the page tells the person how to remove the token, and this line records that it happened.
   */
  const discardTokens = (tag: string, reason: string): void => {
    log('warn', 'link.youtrack.tokensDiscarded', {flowTag: tag, reason});
  };

  // ---- /authorize ----------------------------------------------------------------------------------------------

  const authorize = async (event: FunctionUrlEvent, origin: string): Promise<FunctionUrlResult> => {
    if (!settings.authorizeEnabled) {
      log('info', 'link.authorize.disabled', {});
      return page(403, 'Alexa-initiated linking is not enabled', [
        'This broker links only through its setup link. Nothing was linked.',
      ]);
    }
    const query = queryOf(event);
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    // RFC 6749 section 4.1.2.1: with an unknown client or redirect URI, tell the user and never redirect.
    const clientOk = constantTimeEqual(clientId, secrets.brokerClientId);
    const redirectOk = allowedAlexaRedirects.includes(redirectUri);
    if (!clientOk || !redirectOk) {
      log('warn', 'link.authorize.refused', {clientOk, redirectOk});
      return page(400, 'Link request not valid', [
        'This link request did not come from the skill. Nothing was linked.',
      ]);
    }

    const state = query.get('state') ?? '';
    const refuse = (error: string, reason: string): FunctionUrlResult => {
      log('warn', 'link.authorize.refused', {reason, error});
      const back = new URL(redirectUri);
      back.searchParams.set('error', error);
      if (state !== '' && state.length <= MAX_ALEXA_STATE_LENGTH) back.searchParams.set('state', state);
      return redirect(back.toString());
    };
    if (query.get('response_type') !== 'code') return refuse('unsupported_response_type', 'responseType');
    if (state === '' || state.length > MAX_ALEXA_STATE_LENGTH) return refuse('invalid_request', 'state');

    const challenge = query.get('code_challenge');
    const method = query.get('code_challenge_method');
    if (challenge === undefined && method !== undefined) return refuse('invalid_request', 'pkceMethodWithoutChallenge');
    if (challenge !== undefined && (method !== 'S256' || !isS256Challenge(challenge))) {
      return refuse('invalid_request', 'pkce');
    }

    return startYouTrack(
      {
        flow: 'alexa',
        alexaRedirectUri: redirectUri,
        alexaState: state,
        ...(challenge === undefined ? {} : {alexaChallenge: challenge}),
      },
      origin,
    );
  };

  // ---- /start ----------------------------------------------------------------------------------------------------

  const start = async (event: FunctionUrlEvent, origin: string): Promise<FunctionUrlResult> => {
    // Read from SSM on every request, so deleting the parameter turns /start off at once, warm environments included.
    const setupKey = await setupSecrets.setupKey();
    if (!setupKeyUsable(setupKey)) {
      log('info', 'link.start.refused', {reason: 'disabled'});
      return page(403, 'Setup linking is turned off', ['Nothing was linked.']);
    }
    const key = queryOf(event).get('k') ?? '';
    if (!constantTimeEqual(key, setupKey)) {
      log('warn', 'link.start.refused', {reason: 'key'});
      return page(403, 'Setup link not valid', ['This setup link is not valid. Nothing was linked.']);
    }
    const lwa = await setupSecrets.lwaClient();
    if (lwa === undefined) return notConfigured('lwaClientMissing');

    const lwaState = randomToken(random);
    const verifier = randomToken(random);
    const pending: LwaFlow = {v: 1, verifier};
    await sealAndPut('lwa', lwaState, pending, STATE_TTL_SECONDS);
    const url = new URL(LWA_AUTHORIZE_URL);
    url.searchParams.set('client_id', lwa.clientId);
    url.searchParams.set('scope', LWA_ACCOUNT_LINKING_SCOPE);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', `${origin}/amazon-callback`);
    url.searchParams.set('state', lwaState);
    url.searchParams.set('code_challenge', s256Challenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    log('info', 'link.lwa.authorizeStarted', {lwaTag: flowTag('lwa', lwaState)});
    return redirect(url.toString());
  };

  // ---- /amazon-callback -------------------------------------------------------------------------------------------

  const amazonCallback = async (event: FunctionUrlEvent, origin: string): Promise<FunctionUrlResult> => {
    const query = queryOf(event);
    const lwaState = query.get('state') ?? '';
    if (lwaState === '') return page(400, 'Sign-in not valid', EXPIRED_PAGE_TEXT);
    const pending = await takeAndOpen<LwaFlow>('lwa', lwaState);
    const tag = flowTag('lwa', lwaState);
    if (pending === null) {
      log('warn', 'link.lwa.stateRefused', {lwaTag: tag});
      return page(400, 'Sign-in expired', EXPIRED_PAGE_TEXT);
    }

    const upstreamError = query.get('error');
    const lwaCode = query.get('code') ?? '';
    if (upstreamError !== undefined || lwaCode === '') {
      const code = upstreamError !== undefined && ERROR_CODE.test(upstreamError) ? upstreamError : 'no_code';
      log('warn', 'link.lwa.authorizeFailed', {lwaTag: tag, error: code});
      return page(400, 'Amazon did not sign you in', [
        `Amazon answered: ${code}.`,
        'Nothing was linked, and YouTrack was not asked for anything. Open the setup link again.',
      ]);
    }
    const lwa = await setupSecrets.lwaClient();
    if (lwa === undefined) return notConfigured('lwaClientMissing');

    const scrubber = new Scrubber();
    scrubber.add(...Object.values(secrets), lwa.clientSecret, lwaCode);
    const amazonToken = await exchangeLwaCode(lwaCode, pending.verifier, origin, tag, scrubber, lwa);
    return startYouTrack({flow: 'app', amazonToken}, origin);
  };

  const exchangeLwaCode = async (
    code: string,
    verifier: string,
    origin: string,
    tag: string,
    scrubber: Scrubber,
    lwa: LwaClient,
  ): Promise<string> => {
    const started = clock.now();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${origin}/amazon-callback`,
      client_id: lwa.clientId,
      client_secret: lwa.clientSecret,
      code_verifier: verifier,
    });
    const nothingAsked = 'Nothing was linked, and YouTrack was not asked for anything. Open the setup link again.';
    let response: Response;
    try {
      response = await call(
        LWA_TOKEN_URL,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json'},
          body: body.toString(),
        },
        upstreamTimeoutMs,
      );
    } catch (error) {
      log('warn', 'link.lwa.exchangeFailed', {lwaTag: tag, errorName: errorName(error)});
      throw new Respond(page(502, 'Amazon could not be reached', [nothingAsked]));
    }
    const text = await response.text();
    const token = response.ok ? stringField(parseJson(text), 'access_token') : undefined;
    if (token === undefined || token === '') {
      log('warn', 'link.lwa.exchangeFailed', {
        lwaTag: tag,
        status: response.status,
        error: errorCodeOf(parseJson(text)),
      });
      throw new Respond(
        pageWithDetail(
          502,
          'Amazon refused the sign-in',
          [`Login with Amazon answered ${response.status}. ${nothingAsked} Its message, with any secrets removed:`],
          scrubber.scrub(text).slice(0, MAX_DETAIL_LENGTH),
        ),
      );
    }
    log('info', 'link.lwa.exchanged', {lwaTag: tag, ms: clock.now() - started});
    return token;
  };

  // ---- /youtrack-callback ------------------------------------------------------------------------------------------

  const youtrackCallback = async (event: FunctionUrlEvent, origin: string): Promise<FunctionUrlResult> => {
    const query = queryOf(event);
    const state = query.get('state') ?? '';
    if (state === '') return page(400, 'Sign-in not valid', EXPIRED_PAGE_TEXT);
    // Taken (deleted) before anything else, so a state is spent even when a later step fails.
    const flow = await takeAndOpen<StateFlow>('state', state);
    const tag = flowTag('state', state);
    if (flow === null) {
      log('warn', 'link.youtrack.stateRefused', {flowTag: tag});
      return page(400, 'Sign-in expired', EXPIRED_PAGE_TEXT);
    }

    const upstreamError = query.get('error');
    if (upstreamError !== undefined) {
      const code = ERROR_CODE.test(upstreamError) ? upstreamError : 'error';
      log('warn', 'link.youtrack.authorizeFailed', {flowTag: tag, error: code});
      return page(400, 'YouTrack did not sign you in', [`YouTrack answered: ${code}.`, 'Nothing was linked.']);
    }
    const code = query.get('code') ?? '';
    if (code === '') return page(400, 'Sign-in not valid', ['YouTrack sent no code. Nothing was linked.']);

    const tokens = await exchangeYouTrackCode(code, flow.verifier, origin, tag);
    await requireHouseholdAccount(tokens, tag);

    if (flow.flow === 'alexa') {
      const brokerCode = randomToken(random);
      const grant: CodeGrant = {
        v: 1,
        redirectUri: flow.alexaRedirectUri,
        tokens,
        ...(flow.alexaChallenge === undefined ? {} : {challenge: flow.alexaChallenge}),
      };
      await sealAndPut('code', brokerCode, grant, CODE_TTL_SECONDS);
      log('info', 'link.code.issued', {flow: 'alexa', flowTag: tag, codeTag: flowTag('code', brokerCode)});
      const back = new URL(flow.alexaRedirectUri);
      back.searchParams.set('state', flow.alexaState);
      back.searchParams.set('code', brokerCode);
      return redirect(back.toString());
    }
    return enable(flow.amazonToken, tokens, origin, tag);
  };

  const exchangeYouTrackCode = async (
    code: string,
    verifier: string,
    origin: string,
    tag: string,
  ): Promise<YouTrackTokens> => {
    const started = clock.now();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${origin}/youtrack-callback`,
      code_verifier: verifier,
    });
    let response: Response;
    try {
      response = await call(
        `${hubUrl}/token`,
        {
          method: 'POST',
          headers: {
            Authorization: basicHeader(settings.youtrackClientId, secrets.youtrackClientSecret),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        },
        upstreamTimeoutMs,
      );
    } catch (error) {
      // Hub may have issued tokens whose answer never arrived: recovery applies.
      log('warn', 'link.youtrack.exchangeFailed', {flowTag: tag, errorName: errorName(error)});
      throw new Respond(
        page(502, 'YouTrack could not be reached', ['Nothing was linked.', 'If this happens again:', ...RECOVERY_TEXT]),
      );
    }
    const payload = parseJson(await response.text());
    const tokens = response.ok ? parseTokens(payload) : undefined;
    if (tokens === undefined) {
      const error = errorCodeOf(payload);
      const description = errorDescriptionOf(payload);
      log('warn', 'link.youtrack.exchangeFailed', {flowTag: tag, status: response.status, error, description});
      throw new Respond(
        page(502, 'YouTrack refused the sign-in', [
          `YouTrack answered ${response.status}${error === undefined ? '' : ` (${error})`}.`,
          ...(description === undefined ? [] : [`YouTrack said: ${description}.`]),
          'Nothing was linked. Open a new setup link and try again.',
        ]),
      );
    }
    log('info', 'link.youtrack.exchanged', {
      flowTag: tag,
      refreshToken: tokens.refreshToken === '' ? 'absent' : 'present',
      expiresIn: tokens.expiresIn,
      ms: clock.now() - started,
    });
    if (tokens.refreshToken === '') {
      // Never link a token set without a refresh token: Amazon would hold a link that dies within the hour.
      discardTokens(tag, 'noRefreshToken');
      throw new Respond(
        page(502, 'YouTrack issued no refresh token', [
          'Without one the link would stop working within the hour, so nothing was linked.',
          ...RECOVERY_TEXT,
        ]),
      );
    }
    return tokens;
  };

  /**
   * Only the household account may be linked, identified by its Hub user id (`ringId` on YouTrack's user, "ID of the
   * user in Hub", https://www.jetbrains.com/help/youtrack/devportal/api-entity-User.html), compared exactly. A login
   * can be renamed and case-folded; the id cannot. On any other outcome, drop what YouTrack issued and store nothing.
   */
  const requireHouseholdAccount = async (tokens: YouTrackTokens, tag: string): Promise<void> => {
    const started = clock.now();
    let response: Response;
    try {
      response = await call(
        `${settings.youtrackUrl}/api/users/me?fields=id,login,ringId`,
        {method: 'GET', headers: {Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json'}},
        upstreamTimeoutMs,
      );
    } catch (error) {
      log('warn', 'link.youtrack.accountCheckFailed', {flowTag: tag, errorName: errorName(error)});
      discardTokens(tag, 'accountCheckFailed');
      throw new Respond(
        page(502, 'YouTrack could not be reached', [
          'Nothing was linked.',
          'If it was the household account:',
          ...RECOVERY_TEXT,
        ]),
      );
    }
    const payload = parseJson(await response.text());
    const hubId = response.ok ? stringField(payload, 'ringId') : undefined;
    const login = response.ok ? stringField(payload, 'login') : undefined;
    if (hubId === undefined || hubId === '') {
      log('warn', 'link.youtrack.accountCheckFailed', {flowTag: tag, status: response.status});
      discardTokens(tag, 'accountCheckFailed');
      throw new Respond(
        page(502, 'YouTrack account not confirmed', [
          `YouTrack answered ${response.status} when asked who signed in.`,
          'Nothing was linked. If it was the household account:',
          ...RECOVERY_TEXT,
        ]),
      );
    }
    const match = hubId === settings.householdHubUserId;
    log(match ? 'info' : 'warn', 'link.youtrack.accountChecked', {
      flowTag: tag,
      match,
      loginTag: login === undefined ? undefined : flowTag('login', login),
      loginAsConfigured: login === settings.householdLogin,
      ms: clock.now() - started,
    });
    if (!match) {
      discardTokens(tag, 'accountMismatch');
      throw new Respond(
        page(403, 'Wrong YouTrack account', [
          'Only the household YouTrack account can be linked to this skill, and a different account signed in.',
          'Nothing was linked or saved. The household account was not affected: open a new setup link and sign in ' +
            'to YouTrack as the household account.',
          'YouTrack now holds a refresh token for the account that signed in. An administrator removes it the same ' +
            `way as the household's (runbook, "${RECOVERY_SECTION}"), with that account's user id.`,
        ]),
      );
    }
  };

  /** App-to-app: mint the broker code and ask the Skill Enablement API to link with it. Amazon redeems it at /token. */
  const enable = async (
    amazonToken: string,
    tokens: YouTrackTokens,
    origin: string,
    tag: string,
  ): Promise<FunctionUrlResult> => {
    const scrubber = new Scrubber();
    scrubber.add(...Object.values(secrets), amazonToken, tokens.accessToken, tokens.refreshToken);
    const brokerCode = randomToken(random);
    scrubber.add(brokerCode);
    const redirectUri = `${origin}/amazon-callback`;
    const grant: CodeGrant = {v: 1, redirectUri, tokens};
    await sealAndPut('code', brokerCode, grant, CODE_TTL_SECONDS);
    const codeTag = flowTag('code', brokerCode);
    log('info', 'link.code.issued', {flow: 'app', flowTag: tag, codeTag});

    /** Spends the code if Amazon never redeemed it; true when Amazon did redeem it (it holds the tokens). */
    const spend = async (): Promise<boolean> => {
      const unredeemed = await store.take(recordId('code', brokerCode));
      if (unredeemed !== null) discardTokens(tag, 'codeUnredeemed');
      return unredeemed === null;
    };

    const started = clock.now();
    let response: Response;
    try {
      response = await call(
        `${settings.alexaApiUrl}/v1/users/~current/skills/${settings.skillId}/enablement`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${amazonToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            stage: settings.stage,
            accountLinkRequest: {redirectUri, authCode: brokerCode, type: 'AUTH_CODE'},
          }),
        },
        enablementTimeoutMs,
      );
    } catch (error) {
      const redeemed = await spend();
      log('warn', 'link.enablement.failed', {
        codeTag,
        errorName: errorName(error),
        redeemed,
        ms: clock.now() - started,
      });
      return page(502, 'Not linked: Amazon did not answer', [
        redeemed
          ? 'Amazon called /token and received the YouTrack tokens, but its answer to the enablement call never ' +
            'arrived. Check the link (runbook, step 7) before doing anything else.'
          : 'Amazon never called /token, and the YouTrack tokens were dropped.',
        ...RECOVERY_TEXT,
      ]);
    }
    const text = await response.text();
    const body = parseJson(text);
    const detail = scrubber.scrub(text).slice(0, MAX_DETAIL_LENGTH);
    const rawStatus = stringField(body, 'status');
    const rawLinkStatus = stringField(body, 'accountLink', 'status');
    const status = rawStatus !== undefined && STATUS_WORD.test(rawStatus) ? rawStatus : undefined;
    const linkStatus = rawLinkStatus !== undefined && STATUS_WORD.test(rawLinkStatus) ? rawLinkStatus : undefined;
    const redeemed = await spend();
    // Linked only when Amazon says LINKED and it really redeemed this code (C2): a 201 can carry NOT_LINKED.
    const linked = response.ok && linkStatus === 'LINKED' && redeemed;
    log(linked ? 'info' : 'warn', 'link.enablement.answered', {
      codeTag,
      status: response.status,
      enablementStatus: status,
      accountLinkStatus: linkStatus,
      redeemed,
      linked,
      ms: clock.now() - started,
    });
    if (linked) {
      return pageWithDetail(
        200,
        'Linked',
        [
          `The skill is ${status === undefined ? 'enabled' : status.toLowerCase()} and its account link is LINKED.`,
          'Try "Alexa, open issue desk", then "my issues". Amazon answered:',
        ],
        detail,
      );
    }
    return pageWithDetail(
      502,
      'Not linked',
      [
        `The Skill Enablement API answered ${response.status}, account link status ${linkStatus ?? 'not given'}.`,
        redeemed
          ? 'Amazon called /token and received the YouTrack tokens, but did not report the account as linked.'
          : 'Amazon never called /token, and the YouTrack tokens were dropped.',
        ...RECOVERY_TEXT,
        "Amazon's message, with any secrets removed:",
      ],
      detail,
    );
  };

  // ---- /token ------------------------------------------------------------------------------------------------------

  const tokenError = (status: number, error: string, extra: Readonly<Record<string, string>> = {}) =>
    json(status, {error}, extra);

  const token = async (event: FunctionUrlEvent, startedAt: number): Promise<FunctionUrlResult> => {
    const contentType = (header(event, 'content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
      log('warn', 'link.token.refused', {reason: 'contentType'});
      return tokenError(400, 'invalid_request');
    }
    const params = parseParams(bodyText(event));

    const credentials = basicCredentials(header(event, 'authorization'));
    // Both compared every time, so the response time does not say which one was wrong.
    const idOk = constantTimeEqual(credentials?.clientId ?? '', secrets.brokerClientId);
    const secretOk = constantTimeEqual(credentials?.clientSecret ?? '', secrets.brokerClientSecret);
    if (credentials === undefined || !idOk || !secretOk) {
      log('warn', 'link.token.refused', {reason: 'clientAuth', basic: credentials !== undefined});
      return tokenError(401, 'invalid_client', {'WWW-Authenticate': 'Basic realm="youtrack-voice-link"'});
    }
    if (params.has('client_secret')) {
      // RFC 6749 section 2.3: one authentication method per request.
      log('warn', 'link.token.refused', {reason: 'twoClientAuthMethods'});
      return tokenError(400, 'invalid_request');
    }

    const grantType = params.get('grant_type');
    if (grantType === 'authorization_code') return redeemCode(params);
    if (grantType === 'refresh_token') return refresh(params, startedAt);
    log('warn', 'link.token.refused', {reason: 'grantType'});
    return tokenError(400, 'unsupported_grant_type');
  };

  const redeemCode = async (params: Params): Promise<FunctionUrlResult> => {
    const code = params.get('code') ?? '';
    if (code === '') return tokenError(400, 'invalid_request');
    const codeTag = flowTag('code', code);
    const grant = await takeAndOpen<CodeGrant>('code', code);
    if (grant === null) {
      log('warn', 'link.token.codeRefused', {codeTag, reason: 'unknownExpiredOrUsed'});
      return tokenError(400, 'invalid_grant');
    }
    // The code is spent from here on, whatever follows (RFC 6749 section 4.1.2: "MUST NOT use more than once").
    const redirectUri = params.get('redirect_uri');
    if (redirectUri === undefined || redirectUri !== grant.redirectUri) {
      log('warn', 'link.token.codeRefused', {codeTag, reason: 'redirectUri', present: redirectUri !== undefined});
      return tokenError(400, 'invalid_grant');
    }
    if (grant.challenge !== undefined) {
      const verifier = params.get('code_verifier') ?? '';
      if (!isPkceVerifier(verifier) || !constantTimeEqual(s256Challenge(verifier), grant.challenge)) {
        log('warn', 'link.token.codeRefused', {codeTag, reason: 'pkce'});
        return tokenError(400, 'invalid_grant');
      }
    }
    log('info', 'link.token.issued', {codeTag, pkce: grant.challenge !== undefined});
    return json(200, tokenResponse(grant.tokens, grant.tokens.refreshToken));
  };

  const refresh = async (params: Params, startedAt: number): Promise<FunctionUrlResult> => {
    const refreshToken = params.get('refresh_token') ?? '';
    if (refreshToken === '') return tokenError(400, 'invalid_request');
    const started = clock.now();
    // Whatever is left of Amazon's 4.5 s after the cold build, the table and the parsing so far.
    const remainingMs = tokenBudgetMs - (started - startedAt);
    if (remainingMs < MIN_REFRESH_UPSTREAM_MS) {
      log('warn', 'link.refresh.noBudget', {elapsedMs: started - startedAt});
      return tokenError(503, 'temporarily_unavailable');
    }
    let response: Response;
    try {
      response = await call(
        `${hubUrl}/token`,
        {
          method: 'POST',
          headers: {
            Authorization: basicHeader(settings.youtrackClientId, secrets.youtrackClientSecret),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          // Scope as in the authorization request: Hub's parameter table marks it Required (correctness review C5).
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: settings.youtrackScope,
          }).toString(),
        },
        remainingMs,
      );
    } catch (error) {
      log('warn', 'link.refresh.failed', {
        errorName: errorName(error),
        timeoutMs: remainingMs,
        ms: clock.now() - started,
      });
      return tokenError(503, 'temporarily_unavailable');
    }
    const payload = parseJson(await response.text());
    const tokens = response.ok ? parseTokens(payload) : undefined;
    if (tokens === undefined) {
      const error = errorCodeOf(payload);
      log('warn', 'link.refresh.failed', {status: response.status, error, ms: clock.now() - started});
      // Only YouTrack's own verdict that the refresh token is dead tells Amazon the link is gone. A broker-side
      // problem (a rotated client secret, an outage) must not unlink the household.
      if (response.status === 400 && error === 'invalid_grant') return tokenError(400, 'invalid_grant');
      return tokenError(502, 'server_error');
    }
    log('info', 'link.refresh.proxied', {
      rotated: tokens.refreshToken !== '' && tokens.refreshToken !== refreshToken,
      expiresIn: tokens.expiresIn,
      timeoutMs: remainingMs,
      ms: clock.now() - started,
    });
    // Hub may answer a refresh without a new refresh token; Amazon then keeps using the one it sent.
    return json(200, tokenResponse(tokens, tokens.refreshToken === '' ? refreshToken : tokens.refreshToken));
  };

  // ---- dispatch ----------------------------------------------------------------------------------------------------

  return async (event, context = {}) => {
    const started = clock.now();
    const startedAt = context.startedAt ?? started;
    const coldStart = served === 0;
    served += 1;
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    const path = event.rawPath ?? event.requestContext?.http?.path ?? '/';
    const route = ROUTES.includes(path) ? path : 'other';
    let result: FunctionUrlResult;
    try {
      result = await dispatch(event, method, path, startedAt);
    } catch (error) {
      if (error instanceof Respond) {
        result = error.result;
      } else if (error instanceof BadRequestError) {
        log('warn', 'link.request.bad', {route, problem: error.message});
        result =
          route === '/token'
            ? tokenError(400, 'invalid_request')
            : page(400, 'Request not valid', ['The request was malformed. Nothing was linked.']);
      } else {
        log('error', 'link.request.failed', {route, errorName: errorName(error)});
        result =
          route === '/token'
            ? tokenError(500, 'server_error')
            : page(500, 'Something went wrong', ['Nothing was linked. Try again later.']);
      }
    }
    log('info', 'link.request', {
      route,
      method,
      status: result.statusCode,
      coldStart,
      ms: clock.now() - started,
      // From the invocation's start, so a cold build before this handler ran is counted too.
      sinceInvocationMs: clock.now() - startedAt,
    });
    return result;
  };

  async function dispatch(
    event: FunctionUrlEvent,
    method: string,
    path: string,
    startedAt: number,
  ): Promise<FunctionUrlResult> {
    const origin = originOf(event);
    if (origin === undefined) {
      log('warn', 'link.request.refused', {reason: 'origin'});
      return page(400, 'Not available here', ['This address does not serve account linking.']);
    }
    const expected = path === '/token' ? 'POST' : 'GET';
    if (!ROUTES.includes(path)) return page(404, 'Not found', ['There is nothing here.']);
    if (method !== expected) {
      return path === '/token'
        ? tokenError(405, 'invalid_request', {Allow: 'POST'})
        : withHeader(page(405, 'Method not allowed', ['This address only answers GET.']), 'Allow', 'GET');
    }
    switch (path) {
      case '/authorize':
        return authorize(event, origin);
      case '/start':
        return start(event, origin);
      case '/youtrack-callback':
        return youtrackCallback(event, origin);
      case '/amazon-callback':
        return amazonCallback(event, origin);
      case '/token':
        return token(event, startedAt);
      default:
        return page(404, 'Not found', ['There is nothing here.']);
    }
  }
}

function tokenResponse(tokens: YouTrackTokens, refreshToken: string): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: tokens.tokenType,
    ...(tokens.expiresIn === undefined ? {} : {expires_in: tokens.expiresIn}),
    refresh_token: refreshToken,
  };
}

function withHeader(result: FunctionUrlResult, name: string, value: string): FunctionUrlResult {
  return {...result, headers: {...result.headers, [name]: value}};
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
