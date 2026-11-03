/**
 * The link broker's settings (YA-33), from the Lambda environment. Nothing here is secret: the environment holds the
 * YouTrack instance and OAuth client id, the household login, the skill, the Alexa vendor id, the table name and the
 * SSM prefix. Secrets come from `secrets.ts`. Every check throws at cold start, naming the variable but never its value.
 */
import {isSecureBaseUrl} from '../../config.ts';
import {DEFAULT_SECRETS_PREFIX} from './secrets.ts';

export type SkillStage = 'development' | 'live';

export interface BrokerSettings {
  /** The YouTrack instance, `https:` with no trailing slash; Hub's OAuth endpoints are under `/hub`. */
  youtrackUrl: string;
  /** The YouTrack OAuth client the broker authorises as (a confidential client; its secret is in SSM). */
  youtrackClientId: string;
  /** Space-separated scopes asked of YouTrack: the YouTrack service id and `offline_access`. */
  youtrackScope: string;
  /** The household account's login, for a log field only: the account is identified by `householdHubUserId`. */
  householdLogin: string;
  /**
   * The Hub user id of the only YouTrack account that can ever be linked, compared exactly with the `ringId` YouTrack
   * reports for the signed-in user (security review S4: a login can be renamed or case-folded; the id cannot).
   */
  householdHubUserId: string;
  /** Whether `/authorize` (Alexa-initiated linking) is served. Off unless LINK_BROKER_AUTHORIZE=on (review S1). */
  authorizeEnabled: boolean;
  skillId: string;
  /** The skill stage the Skill Enablement API links. */
  stage: SkillStage;
  /** The Alexa vendor id, from which the three allowed Alexa redirect URLs are built. */
  vendorId: string;
  linkTable: string;
  secretsPrefix: string;
  /**
   * The broker's own origin (`https://<id>.lambda-url.<region>.on.aws`), when pinned. Unset (or `auto`), it's taken from
   * each request's Function URL domain, which must still look like a Function URL.
   */
  brokerOrigin?: string;
  /** The Alexa API origin for the Skill Enablement API: North America by default. */
  alexaApiUrl: string;
}

/** The Alexa API origins by region, the only values ALEXA_API_URL may take. */
export const ALEXA_API_URLS = [
  'https://api.amazonalexa.com',
  'https://api.eu.amazonalexa.com',
  'https://api.fe.amazonalexa.com',
] as const;

/** The three Alexa redirect URL hosts, one per region. */
export const ALEXA_REDIRECT_HOSTS = ['pitangui.amazon.com', 'layla.amazon.com', 'alexa.amazon.co.jp'] as const;

const SKILL_ID = /^amzn1\.ask\.skill\.[0-9a-f-]+$/;
const VENDOR_ID = /^[A-Z0-9]{8,20}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;
const HUB_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_ID = /^[A-Za-z0-9._~-]+$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const SECRETS_PREFIX = /^\/[A-Za-z0-9_.\-/]+\/$/;

/** A Lambda Function URL origin: `https://<url-id>.lambda-url.<region>.on.aws`. */
export const FUNCTION_URL_HOST = /^[a-z0-9]{1,63}\.lambda-url\.[a-z]{2}(-[a-z]+)+-\d\.on\.aws$/;

/** The three Alexa redirect URLs for this vendor: the only `redirect_uri` values `/authorize` accepts. */
export function alexaRedirectUrls(vendorId: string): string[] {
  return ALEXA_REDIRECT_HOSTS.map((host) => `https://${host}/api/skill/link/${vendorId}`);
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = (env[name] ?? '').trim();
  if (value === '') throw new Error(`${name} is required`);
  return value;
}

export function brokerSettings(env: Readonly<Record<string, string | undefined>>): BrokerSettings {
  const youtrackUrl = required(env, 'YOUTRACK_URL').replace(/\/+$/, '');
  if (!isSecureBaseUrl(youtrackUrl)) {
    throw new Error('YOUTRACK_URL must be https: (http: only to localhost), without credentials, query or fragment');
  }

  const youtrackClientId = required(env, 'YOUTRACK_CLIENT_ID');
  if (!CLIENT_ID.test(youtrackClientId)) throw new Error('YOUTRACK_CLIENT_ID must be an OAuth client id');

  const scopes = required(env, 'YOUTRACK_SCOPE').split(/\s+/);
  if (!scopes.every((scope) => SCOPE_TOKEN.test(scope))) throw new Error('YOUTRACK_SCOPE must be OAuth scope tokens');

  const householdLogin = required(env, 'HOUSEHOLD_LOGIN');
  if (!LOGIN.test(householdLogin)) throw new Error('HOUSEHOLD_LOGIN must be a YouTrack login');

  const householdHubUserId = required(env, 'HOUSEHOLD_HUB_USER_ID');
  if (!HUB_USER_ID.test(householdHubUserId)) throw new Error('HOUSEHOLD_HUB_USER_ID must be a Hub user id (a UUID)');

  const authorize = (env.LINK_BROKER_AUTHORIZE ?? '').trim() || 'off';
  if (authorize !== 'on' && authorize !== 'off') throw new Error('LINK_BROKER_AUTHORIZE must be on or off');

  const skillId = required(env, 'SKILL_ID');
  if (!SKILL_ID.test(skillId)) throw new Error('SKILL_ID must be an Alexa skill id');

  const stage = (env.SKILL_STAGE ?? '').trim() || 'development';
  if (stage !== 'development' && stage !== 'live') throw new Error('SKILL_STAGE must be development or live');

  const vendorId = required(env, 'ALEXA_VENDOR_ID');
  if (!VENDOR_ID.test(vendorId)) throw new Error('ALEXA_VENDOR_ID must be an Alexa vendor id');

  const linkTable = required(env, 'LINK_TABLE');
  if (!TABLE.test(linkTable)) throw new Error('LINK_TABLE must be a DynamoDB table name');

  const secretsPrefix = (env.SECRETS_PREFIX ?? '').trim() || DEFAULT_SECRETS_PREFIX;
  if (!SECRETS_PREFIX.test(secretsPrefix)) throw new Error('SECRETS_PREFIX must be an SSM path ending in /');

  const alexaApiUrl = (env.ALEXA_API_URL ?? '').trim().replace(/\/+$/, '') || ALEXA_API_URLS[0];
  if (!(ALEXA_API_URLS as readonly string[]).includes(alexaApiUrl)) {
    throw new Error('ALEXA_API_URL must be one of the Alexa API regional origins');
  }

  const settings: BrokerSettings = {
    youtrackUrl,
    youtrackClientId,
    youtrackScope: scopes.join(' '),
    householdLogin,
    householdHubUserId,
    authorizeEnabled: authorize === 'on',
    skillId,
    stage,
    vendorId,
    linkTable,
    secretsPrefix,
    alexaApiUrl,
  };

  // `auto` (the template default; `sam deploy` cannot pass an empty override) means not pinned.
  const origin = (env.BROKER_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (origin !== '' && origin !== 'auto') {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('BROKER_ORIGIN must be the Function URL origin');
    }
    if (url.protocol !== 'https:' || url.origin !== origin || !FUNCTION_URL_HOST.test(url.hostname)) {
      throw new Error('BROKER_ORIGIN must be the Function URL origin');
    }
    settings.brokerOrigin = origin;
  }
  return settings;
}
