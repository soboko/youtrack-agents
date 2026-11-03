import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {inspect, parseEnv} from 'node:util';

export const DEFAULT_BASE_URL = '';
export const DEFAULT_PROJECT = '';

/** Complete configuration, resolved before identity and workflow construction. */
export interface Config {
  readonly baseUrl: string;
  readonly project: string;
  /**
   * Not enumerable, so `JSON.stringify`, `util.inspect` and `Object.keys` never show it (YA-25 B11). Object spread
   * omits it too: pass the loaded object on rather than a copy.
   */
  readonly token: string;
  /** Where the settings came from: `environment`, an env file path, or `environment + <path>` when both did. */
  readonly source: string;
  readonly owner: string;
  /** True when no YOUTRACK_OWNER was configured and `owner` is the `admin` placeholder (YA-25 B4). */
  readonly ownerIsDefault?: boolean;
  readonly board: string;
  readonly sprintBoard: string;
  readonly teamGroup?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface ConfigOverrides {
  baseUrl?: string;
  project?: string;
  token?: string;
  owner?: string;
  board?: string;
  sprintBoard?: string;
  teamGroup?: string;
}

/** Injectable environment and file candidates keep tests independent of machine credentials. */
export interface ConfigSources {
  environment?: Readonly<Record<string, string | undefined>>;
  files?: readonly string[];
}

/** Lists configuration candidates without reading credentials. */
export function configFiles(
  from = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const files: string[] = [];
  if (env.YOUTRACK_ENV_FILE) files.push(env.YOUTRACK_ENV_FILE);
  let directory = resolve(from);
  for (;;) {
    files.push(join(directory, '.env.youtrack'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  files.push(join(homedir(), '.config', 'youtrack-agents', 'env'));
  return files;
}

/** Compatibility export; loadConfig computes candidates at call time. */
export const CONFIG_FILES = configFiles();

/** Hosts that may receive the token over plain HTTP: a local fake, never a remote tracker (YA-25 B3). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Visible ASCII only, so the token can never break or inject into the Authorization header (YA-25 B6). */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

/** A token that is a nonempty string of visible ASCII; `undefined` (a spread config) never passes (YA-25 Y7). */
export function isHeaderSafeToken(token: unknown): token is string {
  return typeof token === 'string' && HEADER_SAFE_TOKEN.test(token);
}

/**
 * An `https:` URL, or `http:` to a loopback host, with no credentials, query or fragment. Shared by `loadConfig` and
 * the transport, so a hand-built config cannot send the token in cleartext either (YA-25 B3, Y7).
 */
export function isSecureBaseUrl(baseUrl: unknown): baseUrl is string {
  if (typeof baseUrl !== 'string') return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  return secure && !url.username && !url.password && !url.search && !url.hash;
}

/** The owner login `loadConfig` reports when YOUTRACK_OWNER is unset; never assigned unless configured explicitly. */
export const OWNER_PLACEHOLDER = 'admin';

function firstEnvFile(
  files: readonly string[],
): {path: string; values: Record<string, string | undefined>} | undefined {
  const path = files.find((candidate) => existsSync(candidate));
  return path ? {path, values: parseEnv(readFileSync(path, 'utf8'))} : undefined;
}

/**
 * The project key for display, such as help text, from the environment or the first env file. Never requires a token
 * and never throws: an unreadable file just means no project is known.
 */
export function configuredProject(sources: ConfigSources = {}): string | undefined {
  const environment = sources.environment ?? process.env;
  if (environment.YOUTRACK_PROJECT) return environment.YOUTRACK_PROJECT;
  try {
    return firstEnvFile(sources.files ?? configFiles(process.cwd(), environment))?.values.YOUTRACK_PROJECT || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Settings an env file may add beneath a token it did not supply: none. Boards choose which issues a command writes
 * to, and identity keys choose whose name is stamped on those writes, so a planted file must not set them either; they
 * come from the environment, an option, or the file that holds the token (YA-25 Y1, and N1 in the security recheck).
 */
const SHAREABLE_FILE_KEYS = new Set<string>();

/**
 * Explicit options override environment, which overrides the first available env file. An env file supplies every
 * setting only when it also supplies the token. Beneath a token from the environment or an option it adds nothing:
 * an `.env.youtrack` planted in any ancestor directory must never choose where an exported token is sent, what it
 * writes, or whose identity it stamps (YA-25 Y1 and N1, which narrow B4).
 */
export function loadConfig(overrides: ConfigOverrides = {}, sources: ConfigSources = {}): Config {
  const environment = {...(sources.environment ?? process.env)};
  const files = sources.files ?? configFiles(process.cwd(), environment);
  const outsideToken = (overrides.token ?? environment.YOUTRACK_TOKEN)?.trim();
  let source = 'environment';
  let ignoredFile = '';
  const file = firstEnvFile(files);
  // A file holding the very token in use is that token's own source, so it is trusted with every setting.
  const bound = !!outsideToken && file?.values.YOUTRACK_TOKEN?.trim() !== outsideToken;
  if (file) {
    let merged = false;
    for (const [name, value] of Object.entries(file.values)) {
      if (environment[name] !== undefined) continue;
      if (bound && !SHAREABLE_FILE_KEYS.has(name)) {
        ignoredFile = file.path;
        continue;
      }
      environment[name] = value;
      merged = true;
    }
    if (!outsideToken) source = file.path;
    else if (merged) source = `environment + ${file.path}`;
  }
  const token = (overrides.token ?? environment.YOUTRACK_TOKEN ?? '').trim();
  if (!token) throw new Error('no YouTrack token: set YOUTRACK_TOKEN or create .env.youtrack');
  if (!isHeaderSafeToken(token)) {
    throw new Error('YouTrack token must be visible ASCII with no spaces, so it can be sent in an HTTP header');
  }
  const unbound = ignoredFile
    ? ` (${ignoredFile} is not used for it: an env file sets the URL and project only together with its own token)`
    : '';
  const baseUrl = (overrides.baseUrl ?? environment.YOUTRACK_URL ?? '').replace(/\/+$/, '');
  const project = overrides.project ?? environment.YOUTRACK_PROJECT ?? '';
  if (!baseUrl) throw new Error(`no YouTrack URL: set YOUTRACK_URL next to YOUTRACK_TOKEN${unbound}`);
  if (!project) throw new Error(`no YouTrack project: set YOUTRACK_PROJECT${unbound}`);
  // The token is permanent and shared by every agent, so it never crosses a network in cleartext (YA-25 B3).
  if (!isSecureBaseUrl(baseUrl)) {
    throw new Error(
      'YouTrack URL must be https: (http: only for localhost, 127.0.0.1 and ::1), without credentials, query or fragment',
    );
  }
  const board = overrides.board ?? environment.YOUTRACK_BOARD ?? '';
  // An empty YOUTRACK_OWNER= line configures nobody, so it counts as unset.
  const configuredOwner = (overrides.owner ?? environment.YOUTRACK_OWNER)?.trim() || undefined;
  const config = {
    baseUrl,
    project,
    source,
    owner: configuredOwner ?? OWNER_PLACEHOLDER,
    ownerIsDefault: configuredOwner === undefined,
    board,
    sprintBoard: overrides.sprintBoard ?? environment.YOUTRACK_SPRINT_BOARD ?? board,
    teamGroup: overrides.teamGroup ?? environment.YOUTRACK_TEAM_GROUP,
    environment: Object.freeze(
      Object.fromEntries(
        ['AI_MODEL', 'AI_SESSION_ID', 'AI_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID'].map((name) => [
          name,
          environment[name],
        ]),
      ),
    ),
  };
  // Hidden properties keep the credential out of serialisation and inspection, even with showHidden (YA-25 B11).
  Object.defineProperties(config, {
    token: {value: token, enumerable: false},
    [inspect.custom]: {value: () => ({...config, token: '[redacted]'}), enumerable: false},
  });
  // Safe: defineProperties above has just added the token the object literal could not declare as hidden.
  return Object.freeze(config as typeof config & {readonly token: string});
}
