/**
 * The HTTP edge of the link broker (YA-33): the Lambda Function URL event and result shapes (payload format 2.0),
 * strict parsing of query strings, form bodies and HTTP Basic credentials, and the plain responses every route returns.
 *
 * Every response carries `Cache-Control: no-store` (RFC 6749 section 5.1 requires it for token responses; the pages
 * carry codes and outcomes nobody should cache), `Referrer-Policy: no-referrer`, a CSP that allows nothing but inline
 * style, and no CORS header of any kind.
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 */

/** The parts of a Function URL request event the broker reads. Header names arrive lower-cased. */
export interface FunctionUrlEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    domainName?: string;
    http?: {method?: string; path?: string};
    requestId?: string;
  };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** The largest request body read, in bytes. A token request is a few hundred. */
export const MAX_BODY_BYTES = 16_384;

/** The longest query string read. Alexa's authorization request, with a long state, is well under this. */
export const MAX_QUERY_LENGTH = 4096;

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

/** Query or form parameters, with at most one value per name. */
export type Params = ReadonlyMap<string, string>;

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Parses `application/x-www-form-urlencoded` text (a query string or a form body). A repeated parameter is refused
 * (RFC 6749 section 3.1: "Request and response parameters MUST NOT be included more than once").
 */
export function parseParams(text: string): Params {
  const params = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(text)) {
    if (params.has(name)) throw new BadRequestError(`parameter ${name.slice(0, 40)} repeated`);
    params.set(name, value);
  }
  return params;
}

export function queryOf(event: FunctionUrlEvent): Params {
  const raw = event.rawQueryString ?? '';
  if (raw.length > MAX_QUERY_LENGTH) throw new BadRequestError('query too long');
  return parseParams(raw);
}

export function header(event: FunctionUrlEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** The request body as text, decoded from base64 when the Function URL encoded it. Refuses oversized bodies. */
export function bodyText(event: FunctionUrlEvent): string {
  const raw = event.body ?? '';
  const text = event.isBase64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new BadRequestError('body too large');
  return text;
}

export interface BasicCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * HTTP Basic client credentials (RFC 6749 section 2.3.1: the id and secret are form-urlencoded, then joined by a
 * colon and base64-encoded). Returns undefined when the header is absent or malformed.
 */
export function basicCredentials(authorization: string | undefined): BasicCredentials | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(authorization);
  if (match?.[1] === undefined) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  try {
    const formDecode = (part: string): string => decodeURIComponent(part.replace(/\+/g, ' '));
    return {clientId: formDecode(decoded.slice(0, colon)), clientSecret: formDecode(decoded.slice(colon + 1))};
  } catch {
    return undefined;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A plain HTML page: a heading and paragraphs, all escaped. No script, no external resource, no form. */
export function page(statusCode: number, title: string, paragraphs: readonly string[]): FunctionUrlResult {
  const body = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}',
    'pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:.75rem}</style>',
    '</head><body>',
    `<h1>${escapeHtml(title)}</h1>`,
    ...paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`),
    '</body></html>',
  ].join('\n');
  return {statusCode, headers: {...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8'}, body};
}

/** A plain page with a preformatted block, for an upstream message shown verbatim (already scrubbed by the caller). */
export function pageWithDetail(
  statusCode: number,
  title: string,
  paragraphs: readonly string[],
  detail: string,
): FunctionUrlResult {
  const result = page(statusCode, title, paragraphs);
  result.body = result.body.replace('</body>', `<pre>${escapeHtml(detail)}</pre>\n</body>`);
  return result;
}

export function redirect(location: string): FunctionUrlResult {
  return {statusCode: 302, headers: {...COMMON_HEADERS, Location: location, 'Content-Type': 'text/plain'}, body: ''};
}

/** A JSON response for `/token`: a token response (RFC 6749 section 5.1) or an error (section 5.2). */
export function json(
  statusCode: number,
  value: Readonly<Record<string, unknown>>,
  extraHeaders: Readonly<Record<string, string>> = {},
): FunctionUrlResult {
  return {
    statusCode,
    headers: {...COMMON_HEADERS, 'Content-Type': 'application/json;charset=UTF-8', ...extraHeaders},
    body: JSON.stringify(value),
  };
}
