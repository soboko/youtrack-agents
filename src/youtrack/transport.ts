import {inspect} from 'node:util';
import {isHeaderSafeToken, isSecureBaseUrl} from '../config.ts';
import type {Config} from '../config.ts';
import {TrackerFailure} from '../tracker.ts';
import type {TrackerFailureKind} from '../tracker.ts';

/** The most characters of provider error detail kept for `--debug`. */
const DETAIL_LIMIT = 300;

/**
 * HTTP errors expose status, never provider bodies that may echo issue data or credentials. `detail` holds only the
 * provider's `error` and `error_description`, truncated and with the token stripped, for `--debug`. It is
 * non-enumerable, so serialising the error never includes it.
 */
export class YouTrackError extends TrackerFailure {
  readonly status: number;
  readonly body: string;
  declare readonly detail: string;

  constructor(status: number, _body: string, message: string, kind?: TrackerFailureKind, detail = '') {
    super(kind ?? failureKind(status), message);
    this.name = 'YouTrackError';
    this.status = status;
    this.body = '[response body omitted]';
    Object.defineProperty(this, 'detail', {value: detail, enumerable: false});
  }
}

/** Statuses whose meaning is known; any other 4xx says nothing definite about whether a write was applied. */
const MAPPED_KINDS: ReadonlyMap<number, TrackerFailureKind> = new Map([
  [400, 'validation'],
  [401, 'permission'],
  [403, 'permission'],
  [404, 'not-found'],
  [409, 'conflict'],
  [412, 'conflict'],
  [422, 'validation'],
]);

function failureKind(status: number): TrackerFailureKind {
  return MAPPED_KINDS.get(status) ?? 'unavailable';
}

/**
 * A write is refused only by a status that says nothing was applied. A server error, a request timeout (408), a
 * client-closed request (499) or any other unmapped status may follow a committed mutation.
 */
function writeFailureKind(status: number): TrackerFailureKind {
  return MAPPED_KINDS.get(status) ?? 'unknown';
}

/** YouTrack permanent tokens look like `perm:<base64>.<base64>.<secret>` (older ones use `perm-`). */
const TOKEN_SHAPE = /perm[:-][A-Za-z0-9+/=._-]+/g;

/** A token component this long is secret enough to strip on its own, such as the signature after the last dot. */
const SECRET_PART_LENGTH = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the token from provider text in every form found echoed back: any letter case, without its `perm:` prefix,
 * each long component on its own, and its base64, base64url and URL-encoded forms (YA-25 Y2). Longest forms go
 * first, so a whole token becomes one marker rather than several.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  const unprefixed = token.replace(/^perm[:-]/i, '');
  const forms = new Set([
    token,
    unprefixed,
    encodeURIComponent(token),
    Buffer.from(token).toString('base64'),
    Buffer.from(token).toString('base64url'),
    Buffer.from(unprefixed).toString('base64'),
    ...token.split(/[.:-]/).filter((part) => part.length >= SECRET_PART_LENGTH),
  ]);
  let redacted = text;
  for (const form of [...forms].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(form), 'gi'), '[token]');
  }
  return redacted;
}

/** Extracts `error: error_description` from a provider error body, truncated and with credentials removed. */
export function providerDetail(text: string, token: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '';
  }
  if (parsed === null || typeof parsed !== 'object') return '';
  const record = parsed as Record<string, unknown>;
  const parts = [record.error, record.error_description].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  let detail = redactToken(parts.join(': '), token);
  detail = detail.replace(TOKEN_SHAPE, '[token]').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}...` : detail;
}

/**
 * One path segment, shared by every module that builds a request path (YA-25 Y4). Ids are data, so none can add a
 * segment, a query or a fragment. Encoding leaves `.` and `..` as they are and URL parsing would resolve them, so
 * those and an empty or non-string id are refused before any request.
 */
export function segment(value: string): string {
  if (typeof value !== 'string' || /^\.{0,2}$/.test(value)) {
    throw new TrackerFailure('validation', `Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

/** Running totals of mutating requests; callers compare snapshots to tell rejected from partial or unknown. */
export interface WriteCounts {
  /** Mutating requests handed to the fetch implementation. */
  readonly dispatched: number;
  /** Mutating requests answered 2xx with a nonempty body that parsed as JSON. */
  readonly confirmed: number;
  /** Mutating requests the provider answered with a status that says nothing was applied. */
  readonly refused: number;
}

/** A capped collection: `truncated` is true when the provider holds more than the requested limit. */
export interface CollectionPage<T> {
  values: T[];
  truncated: boolean;
}

/** The most items an uncapped `collect` enumerates before failing as incomplete. */
const SAFETY_LIMIT = 100_000;

/** The provider's page size for collection requests. */
const PAGE_SIZE = 100;

/** Dependency-free transport with bounded response time and no automatic mutation retries. */
export class YouTrackTransport {
  // Non-enumerable (set in the constructor) so the credential never serialises with the transport.
  declare private readonly config: Config;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private dispatched = 0;
  private confirmed = 0;
  private refused = 0;

  constructor(config: Config, options: {fetch?: typeof fetch; timeoutMs?: number} = {}) {
    // A config need not come from loadConfig, so the transport repeats its checks: no token-less or header-breaking
    // Authorization, and no cleartext to a remote host (YA-25 Y7). Neither message repeats the value.
    if (!isHeaderSafeToken(config.token)) {
      throw new TrackerFailure('validation', 'YouTrack token is missing or cannot be sent in an HTTP header');
    }
    if (!isSecureBaseUrl(config.baseUrl)) {
      throw new TrackerFailure(
        'validation',
        'YouTrack URL must be https: (http: only for localhost, 127.0.0.1 and ::1), without credentials, query or fragment',
      );
    }
    Object.defineProperty(this, 'config', {value: config, enumerable: false});
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 300_000) {
      throw new TrackerFailure('validation', 'timeoutMs must be positive and at most 300000');
    }
  }

  /** A snapshot; a write neither confirmed nor refused may have been applied. */
  get writes(): WriteCounts {
    return {dispatched: this.dispatched, confirmed: this.confirmed, refused: this.refused};
  }

  toJSON(): Record<string, unknown> {
    return {baseUrl: this.config.baseUrl, token: '[redacted]', writes: this.writes};
  }

  [inspect.custom](): string {
    return `YouTrackTransport { baseUrl: '${this.config.baseUrl}', token: [redacted] }`;
  }

  async request<T>(method: string, apiPath: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.config.baseUrl}/api/${apiPath.replace(/^\/+/, '')}`);
    const apiRoot = new URL(`${this.config.baseUrl}/api/`);
    if (url.origin !== apiRoot.origin || !url.pathname.startsWith(apiRoot.pathname)) {
      throw new TrackerFailure('validation', 'API path must remain beneath the configured API root');
    }
    // Checked where the header is built, before anything is dispatched; the message never repeats the token.
    if (!isHeaderSafeToken(this.config.token)) {
      throw new TrackerFailure('validation', 'YouTrack token contains characters that cannot be sent in a header');
    }
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readOnly = method === 'GET' || method === 'HEAD';
    const unavailable = (): TrackerFailure =>
      new TrackerFailure(
        readOnly ? 'unavailable' : 'unknown',
        readOnly
          ? 'YouTrack request failed or timed out'
          : 'YouTrack write outcome is unknown; reconcile before retrying',
      );
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(unavailable());
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          if (!readOnly) this.dispatched++;
          const response = await this.fetcher(url, {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.config.token}`,
              Accept: 'application/json',
              ...(serialized === undefined ? {} : {'Content-Type': 'application/json'}),
            },
            body: serialized,
          });
          if (!response.ok) {
            // A server error can occur after committing a mutation. Never label that safe to retry.
            const kind = readOnly ? failureKind(response.status) : writeFailureKind(response.status);
            if (!readOnly && kind !== 'unknown') this.refused++;
            let detail = '';
            try {
              detail = providerDetail(await response.text(), this.config.token);
            } catch {
              // An unreadable error body only loses debug detail; the status still classifies the failure.
            }
            throw new YouTrackError(response.status, '', `YouTrack HTTP ${response.status}`, kind, detail);
          }
          const text = await response.text();
          // Generic JSON shape is a provider boundary; endpoint mappers validate relevant fields.
          const parsed = (text ? JSON.parse(text) : null) as T;
          // An empty 2xx carries no receipt; only a parsed body confirms a write.
          if (!readOnly && text) this.confirmed++;
          return parsed;
        })(),
      ]);
    } catch (error) {
      if (error instanceof TrackerFailure) throw error;
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Fetches at most `limit` items and one more, so the result says whether the provider holds more than the limit.
   */
  async collectPage<T>(apiPath: string, query: Record<string, string>, limit: number): Promise<CollectionPage<T>> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TrackerFailure('validation', 'Collection limit must be a nonnegative integer');
    }
    const values: T[] = [];
    const wanted = limit + 1;
    while (values.length < wanted) {
      const size = Math.min(PAGE_SIZE, wanted - values.length);
      const page = await this.request<T[]>('GET', apiPath, undefined, {
        ...query,
        $top: String(size),
        $skip: String(values.length),
      });
      if (!Array.isArray(page)) throw new TrackerFailure('unavailable', 'Expected a YouTrack collection');
      if (page.length > size) throw new TrackerFailure('unavailable', 'Provider ignored collection page size');
      values.push(...page);
      if (page.length < size) break;
    }
    return {values: values.slice(0, limit), truncated: values.length > limit};
  }

  /**
   * Enumerates top-level collections. Without a limit, reaching the safety limit fails instead of returning a
   * truncated inventory; with a limit, the first `limit` items are returned (use `collectPage` to learn whether
   * more exist).
   */
  async collect<T>(apiPath: string, query: Record<string, string> = {}, limit?: number): Promise<T[]> {
    const page = await this.collectPage<T>(apiPath, query, limit ?? SAFETY_LIMIT);
    if (limit === undefined && page.truncated) {
      throw new TrackerFailure('unavailable', 'Collection safety limit reached; inventory incomplete');
    }
    return page.values;
  }
}
