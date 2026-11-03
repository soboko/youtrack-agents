/**
 * `trackerFor(accessToken)` over YouTrack (YA-15): one `VoiceTracker` per linked credential, scoped to one project,
 * by default H (Household), the only project the household account can see.
 *
 * Where each setting comes from (the Y1 rule, one source for all three): the URL and project from the Lambda's own
 * environment, read once by `bindingSettings`, and the token from the account link of this request only. They meet in
 * the library's `loadConfig` as explicit options with an empty environment and no env files, so its https-only and
 * header-safe checks apply and no `.env.youtrack` is ever read.
 *
 * Each call builds a fresh client, adapter and tracker. Nothing that reads data is shared between two tokens. The
 * binding remembers one thing per token for the life of the warm container: the YouTrack login a SHA-256 digest of
 * that token belongs to, so the login is looked up (and logged) once per token, and an account-level link is checked
 * against HOUSEHOLD_LOGIN once per token rather than on every call.
 */
import {createHash} from 'node:crypto';
import {isSecureBaseUrl, loadConfig} from '../../config.ts';
import type {TrackerPort} from '../../tracker.ts';
import {createTrackerAdapter} from '../../youtrack/adapter.ts';
import {createClient} from '../../youtrack/client.ts';
import {redactToken} from '../../youtrack/transport.ts';
import {idTag} from '../alexa/log.ts';
import type {VoiceLogger, VoiceTracker} from '../core/types.ts';
import {createVoiceTracker, voiceFailure, VoiceTrackerFailure} from './voice-tracker.ts';

/** The voice client's project unless YOUTRACK_PROJECT names another: H (Household), owner's decision 2026-09-13. */
export const DEFAULT_VOICE_PROJECT = 'H';

/**
 * How long one YouTrack request may take. The Alexa handler answers by 7 s on its own, so a request that would outlive
 * the turn is cut well before the platform's limit rather than at the library's 30 s default.
 */
export const DEFAULT_TRACKER_TIMEOUT_MS = 5000;

/** How many tokens' logins are remembered. A refreshed token is a new entry; the oldest go first. */
export const KNOWN_LINKS_LIMIT = 256;

/** A YouTrack project short name: nothing that could add query syntax after `project:`. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A YouTrack login, as the adapter accepts one in a query. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

/** Stamped on writes by the library. The voice tracker has none; the identity only satisfies the client. */
const VOICE_IDENTITY = {model: 'voice-client', session: 'voice-binding'};

export interface YouTrackBindingSettings {
  /** `https:` origin and path of the instance, no trailing slash. */
  baseUrl: string;
  /** Project short name; every query and every issue key is scoped to it. */
  project: string;
  /**
   * The dedicated household account's login. When set, a token that is not a recognised person's own link reads
   * nothing unless it belongs to this login.
   */
  householdLogin?: string;
}

/**
 * The instance, project and household login from the Lambda environment: YOUTRACK_URL (required), YOUTRACK_PROJECT
 * (default H) and HOUSEHOLD_LOGIN (optional here; the full entry requires it with the account-level fallback on).
 * Throws at cold start on a missing or insecure URL or a malformed value, naming the variable but never its value.
 */
export function bindingSettings(env: Readonly<Record<string, string | undefined>>): YouTrackBindingSettings {
  const baseUrl = (env.YOUTRACK_URL ?? '').trim().replace(/\/+$/, '');
  if (baseUrl === '') throw new Error('YOUTRACK_URL is required');
  if (!isSecureBaseUrl(baseUrl)) {
    throw new Error('YOUTRACK_URL must be https: (http: only to localhost), without credentials, query or fragment');
  }
  const project = (env.YOUTRACK_PROJECT ?? '').trim() || DEFAULT_VOICE_PROJECT;
  if (!PROJECT_KEY.test(project)) throw new Error('YOUTRACK_PROJECT must be a project short name, such as H');
  const settings: YouTrackBindingSettings = {baseUrl, project};
  const householdLogin = (env.HOUSEHOLD_LOGIN ?? '').trim();
  if (householdLogin !== '') {
    if (!LOGIN.test(householdLogin)) throw new Error('HOUSEHOLD_LOGIN must be a YouTrack login');
    settings.householdLogin = householdLogin;
  }
  return settings;
}

export interface TrackerFactoryOptions {
  settings: YouTrackBindingSettings;
  log: VoiceLogger;
  /** The fetch every YouTrack request goes through; the global fetch by default. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** For the timing in the link log line. */
  now?: () => number;
}

export interface TrackerForOptions {
  /** The turn's deadline. Once it fires no call starts, and requests already in flight are aborted. */
  signal?: AbortSignal;
  /**
   * Which link the token came from. Only `person` (a recognised person's own link) is exempt from the household
   * login check; a token of unknown origin is checked like an account-level one.
   */
  linkedVia?: 'person' | 'account';
  /** For log lines. */
  requestId?: string;
}

export type TrackerFor = (accessToken: string, options?: TrackerForOptions) => VoiceTracker;

/** An account-level link that belongs to a YouTrack account other than HOUSEHOLD_LOGIN. The message names neither. */
export class LinkMismatchError extends Error {
  constructor() {
    super('The linked YouTrack account is not the household account');
    this.name = 'LinkMismatchError';
  }
}

export interface YouTrackBinding {
  trackerFor: TrackerFor;
  /**
   * Checks the link before a turn reads anything. For a link the household login applies to, it resolves only for
   * that login, rejects with `LinkMismatchError` for another, and rejects with the lookup's failure when the login
   * cannot be learned. For a person's own link it resolves at once and logs the login in the background.
   */
  checkLink(accessToken: string, options?: TrackerForOptions): Promise<void>;
}

/** Removes the token in every form the transport knows, and anything shaped like a bearer credential. */
export function redactorFor(accessToken: string): (text: string) => string {
  return (text) => redactToken(text, accessToken).replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [token]');
}

function fetchWithSignal(base: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) =>
    base(input, {...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal});
}

export function createYouTrackBinding(options: TrackerFactoryOptions): YouTrackBinding {
  const {settings, log} = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRACKER_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const householdLogin = settings.householdLogin;
  // Token digest -> login, in insertion order, so the oldest entry is the first one iterated.
  const logins = new Map<string, string>();
  // Token digest -> the lookup in progress, so a turn's link check and its first call share one request.
  const lookups = new Map<string, Promise<string>>();

  log('info', 'voice.binding.config', {
    project: settings.project,
    host: new URL(settings.baseUrl).host,
    timeoutMs,
    householdLoginConfigured: householdLogin !== undefined,
  });

  const portFor = (accessToken: string, signal: AbortSignal | undefined): TrackerPort | null => {
    try {
      const config = loadConfig(
        {baseUrl: settings.baseUrl, project: settings.project, token: accessToken},
        {environment: {}, files: []},
      );
      const base = options.fetch ?? globalThis.fetch;
      const client = createClient(VOICE_IDENTITY, {
        config,
        fetch: signal ? fetchWithSignal(base, signal) : base,
        timeoutMs,
      });
      return createTrackerAdapter(client);
    } catch {
      // loadConfig's and the transport's messages never repeat the token; the URL and project were checked at start.
      return null;
    }
  };

  const digestOf = (accessToken: string): string => createHash('sha256').update(accessToken).digest('hex');
  const requiresHousehold = (linkedVia: TrackerForOptions['linkedVia']): boolean =>
    householdLogin !== undefined && linkedVia !== 'person';
  const isHousehold = (login: string): boolean => login.toLowerCase() === householdLogin?.toLowerCase();

  /** The login a token belongs to: remembered, or looked up once and logged at info as a tag. */
  const loginFor = (accessToken: string, perTurn: TrackerForOptions, port: TrackerPort): Promise<string> => {
    const digest = digestOf(accessToken);
    const known = logins.get(digest);
    if (known !== undefined) return Promise.resolve(known);
    const pending = lookups.get(digest);
    if (pending !== undefined) return pending;

    const started = now();
    const lookup = (async () => {
      const actor = await port.currentActor();
      logins.set(digest, actor.id);
      if (logins.size > KNOWN_LINKS_LIMIT) {
        const oldest = logins.keys().next().value;
        if (oldest !== undefined) logins.delete(oldest);
      }
      log('info', 'voice.binding.linked', {
        requestId: perTurn.requestId,
        linkedVia: perTurn.linkedVia,
        project: settings.project,
        loginTag: idTag(actor.id),
        householdLogin: requiresHousehold(perTurn.linkedVia) ? (isHousehold(actor.id) ? 'match' : 'mismatch') : 'n/a',
        ms: now() - started,
      });
      log('debug', 'voice.binding.linkedDetail', {requestId: perTurn.requestId, login: actor.id});
      return actor.id;
    })();
    lookups.set(digest, lookup);
    const forget = (): void => {
      lookups.delete(digest);
    };
    lookup.then(forget, forget);
    return lookup;
  };

  const checkWith = async (accessToken: string, perTurn: TrackerForOptions, port: TrackerPort): Promise<void> => {
    const fields = {requestId: perTurn.requestId, linkedVia: perTurn.linkedVia, project: settings.project};
    if (!requiresHousehold(perTurn.linkedVia)) {
      // Logging only: a person's own link may be any account, so the turn never waits for it.
      loginFor(accessToken, perTurn, port).catch((error: unknown) => {
        log('warn', 'voice.binding.linkUnconfirmed', {...fields, kind: voiceFailure(error, false, (t) => t).kind});
      });
      return;
    }
    let login: string;
    try {
      login = await loginFor(accessToken, perTurn, port);
    } catch (error) {
      const failure = voiceFailure(error, false, redactorFor(accessToken));
      log('warn', 'voice.binding.linkUnconfirmed', {...fields, kind: failure.kind, status: failure.status});
      throw failure;
    }
    if (!isHousehold(login)) {
      log('warn', 'voice.binding.loginMismatch', {
        ...fields,
        loginTag: idTag(login),
        expectedTag: idTag(householdLogin),
      });
      throw new LinkMismatchError();
    }
  };

  const refusal = (): VoiceTrackerFailure =>
    new VoiceTrackerFailure('permission', 'Linked credential cannot be used with YouTrack');

  return {
    checkLink: async (accessToken, perTurn = {}) => {
      const port = portFor(accessToken, perTurn.signal);
      if (port === null) {
        log('warn', 'voice.binding.credentialRefused', {requestId: perTurn.requestId, project: settings.project});
        throw refusal();
      }
      await checkWith(accessToken, perTurn, port);
    },

    trackerFor: (accessToken, perTurn = {}) => {
      const port = portFor(accessToken, perTurn.signal);
      if (port === null) {
        log('warn', 'voice.binding.credentialRefused', {requestId: perTurn.requestId, project: settings.project});
        const refuse = (): Promise<never> => Promise.reject(refusal());
        return {listIssues: refuse, getIssue: refuse, listComments: refuse, listAssignees: refuse};
      }
      let checked: Promise<void> | undefined;
      const tracker = createVoiceTracker(port, {
        project: settings.project,
        signal: perTurn.signal,
        redact: redactorFor(accessToken),
        log,
        requestId: perTurn.requestId,
        // Every call waits for the link check, made once per tracker (one turn) and remembered per token after it
        // succeeds; a mismatch is a permission failure.
        beforeCall: () => {
          checked ??= checkWith(accessToken, perTurn, port).catch((error: unknown) => {
            throw error instanceof LinkMismatchError ? new VoiceTrackerFailure('permission', error.message) : error;
          });
          return checked;
        },
      });
      log('debug', 'voice.binding.trackerCreated', {
        requestId: perTurn.requestId,
        project: settings.project,
        signal: perTurn.signal !== undefined,
      });
      return tracker;
    },
  };
}
