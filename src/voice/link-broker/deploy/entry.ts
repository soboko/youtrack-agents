/**
 * The link broker's Lambda entry (YA-33): `createLinkBroker` with the settings from the environment, the secrets from
 * SSM, the DynamoDB link table, the JSON logger, the system clock, `crypto.randomBytes` and the global fetch. Handler
 * path `voice/link-broker/deploy/entry.handler`; built like the skill's full entry (docs/voice/alexa.md, section
 * "Linking without the Alexa app (YA-33)").
 *
 * Environment (nothing secret): YOUTRACK_URL, YOUTRACK_CLIENT_ID, YOUTRACK_SCOPE, HOUSEHOLD_LOGIN,
 * HOUSEHOLD_HUB_USER_ID, SKILL_ID, SKILL_STAGE, ALEXA_VENDOR_ID, LINK_TABLE, SECRETS_PREFIX, LINK_BROKER_AUTHORIZE
 * (default off), BROKER_ORIGIN (optional), ALEXA_API_URL (optional) and LOG_LEVEL (default info).
 *
 * The SDKs. `@aws-sdk/client-dynamodb` and `@aws-sdk/client-ssm` ship in the Lambda Node.js runtime but are not
 * dependencies of this repository, so, as in `alexa/deploy/lambda-entry.ts`, each is imported dynamically by a
 * specifier held in a variable and checked at runtime for the one constructor used.
 *
 * When it builds (correctness review C4). Amazon expects `/token` to answer within 4.5 s, and `/token` is usually the
 * first request of a fresh execution environment. So the handler is built during Lambda **init**, by a top-level await:
 * the SDK imports and the one `GetParameters` call for the token secrets run with init's CPU and outside the request's
 * time. A build that fails at init is logged and tried again on the next invocation. The token secrets are kept for
 * the life of the environment, so rotating one takes effect on the next cold start; the setup secrets are read per
 * request (secrets.ts).
 */
import {randomBytes} from 'node:crypto';
import {createJsonLogger, parseLogLevel} from '../../alexa/log.ts';
import {brokerSettings} from '../config.ts';
import {createLinkBroker, type BrokerClock, type LinkBrokerHandler} from '../handler.ts';
import type {FunctionUrlEvent, FunctionUrlResult} from '../http.ts';
import {loadTokenSecrets, ssmSetupSecrets, type SsmParameterClient} from '../secrets.ts';
import {createDynamoLinkStore, type LinkItemClient} from '../store.ts';

/** Held in variables so TypeScript does not try to resolve modules this repository does not install. */
export const DYNAMO_SDK_MODULE = '@aws-sdk/client-dynamodb';
export const SSM_SDK_MODULE = '@aws-sdk/client-ssm';

/** Two attempts and short timeouts: `/token` has to answer Amazon within 4.5 seconds. */
export const SDK_CLIENT_CONFIG = {
  maxAttempts: 2,
  requestHandler: {requestTimeout: 1500, connectionTimeout: 500},
} as const;

interface DynamoSdk {
  DynamoDB: new (config: typeof SDK_CLIENT_CONFIG) => LinkItemClient;
}

interface SsmSdk {
  SSM: new (config: typeof SDK_CLIENT_CONFIG) => SsmParameterClient;
}

function hasConstructor(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[name] === 'function';
}

export const systemClock: BrokerClock = {now: () => Date.now()};

export interface LinkEntryOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Where log lines go; stdout (CloudWatch Logs) by default. */
  write?: (line: string) => void;
  /** Test seams: the SDK modules instead of the dynamic imports, or ready clients instead of the SDKs. */
  loadDynamoSdk?: () => Promise<unknown>;
  loadSsmSdk?: () => Promise<unknown>;
  dynamo?: LinkItemClient;
  ssm?: SsmParameterClient;
  fetch?: typeof fetch;
  clock?: BrokerClock;
  random?: (size: number) => Uint8Array;
}

/** Builds the handler. Throws, after logging why, if the environment, a secret or an SDK is missing. */
export async function createLinkEntry(options: LinkEntryOptions): Promise<LinkBrokerHandler> {
  const {env} = options;
  const clock = options.clock ?? systemClock;
  const log = createJsonLogger({
    level: parseLogLevel(env.LOG_LEVEL, 'info'),
    now: () => clock.now(),
    ...(options.write ? {write: options.write} : {}),
  });
  const started = clock.now();

  try {
    const settings = brokerSettings(env);

    let ssm = options.ssm;
    if (ssm === undefined) {
      const sdk: unknown = await (options.loadSsmSdk ?? (() => import(SSM_SDK_MODULE)))();
      if (!hasConstructor(sdk, 'SSM')) throw new Error(`${SSM_SDK_MODULE} does not export an SSM client`);
      ssm = new (sdk as SsmSdk).SSM(SDK_CLIENT_CONFIG);
    }
    const secrets = await loadTokenSecrets(ssm, settings.secretsPrefix);

    let dynamo = options.dynamo;
    if (dynamo === undefined) {
      const sdk: unknown = await (options.loadDynamoSdk ?? (() => import(DYNAMO_SDK_MODULE)))();
      if (!hasConstructor(sdk, 'DynamoDB')) throw new Error(`${DYNAMO_SDK_MODULE} does not export a DynamoDB client`);
      dynamo = new (sdk as DynamoSdk).DynamoDB(SDK_CLIENT_CONFIG);
    }
    const store = createDynamoLinkStore({client: dynamo, tableName: settings.linkTable, now: () => clock.now()});

    const handler = createLinkBroker({
      settings,
      secrets,
      setupSecrets: ssmSetupSecrets(ssm, settings.secretsPrefix),
      store,
      fetch: options.fetch ?? globalThis.fetch,
      clock,
      random: options.random ?? ((size) => randomBytes(size)),
      log,
    });
    log('info', 'link.entry.ready', {
      stage: settings.stage,
      youtrackHost: new URL(settings.youtrackUrl).host,
      originPinned: settings.brokerOrigin !== undefined,
      authorizeEnabled: settings.authorizeEnabled,
      // Not a secret: the template's LinkBrokerSecretsEpoch, changed to replace environments after a rotation.
      secretsEpoch: /^[0-9]{1,6}$/.test(env.SECRETS_EPOCH ?? '') ? env.SECRETS_EPOCH : undefined,
      ms: clock.now() - started,
    });
    return handler;
  } catch (error) {
    // Config and secret errors name variables and parameters, never values; an import failure names the module.
    log('error', 'link.entry.startFailed', {
      problem: error instanceof Error ? error.message : 'unknown',
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}

let ready: Promise<LinkBrokerHandler> | undefined;

function build(): Promise<LinkBrokerHandler> {
  const attempt = createLinkEntry({env: process.env});
  ready = attempt;
  attempt.catch(() => {
    // Logged by createLinkEntry; the next invocation builds again.
    if (ready === attempt) ready = undefined;
  });
  return attempt;
}

// Lambda init: build now, so the first request (usually Amazon's /token) does not pay for it. Only inside Lambda, so a
// test importing this module builds nothing. A failure here must not fail init; the handler retries.
if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
  await build().catch(() => undefined);
}

/** The Lambda entry point: `voice/link-broker/deploy/entry.handler`. */
export const handler = async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
  const startedAt = systemClock.now();
  const broker = await (ready ?? build());
  return broker(event, {startedAt});
};
