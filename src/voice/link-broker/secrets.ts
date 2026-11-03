/**
 * The broker's secrets (YA-33), from SSM Parameter Store SecureString parameters under one prefix. Nothing secret is in
 * the template or the environment; the environment names only the prefix.
 *
 * Two groups, read differently:
 *
 * - **Token secrets** (`youtrack-client-secret`, `broker-client-id`, `broker-client-secret`) serve `/token`, which
 *   Amazon calls about hourly and expects an answer from within 4.5 s. They are read in one `GetParameters` call at
 *   Lambda init and kept for the life of the execution environment.
 * - **Setup secrets** (`setup-key`, `lwa-client-id`, `lwa-client-secret`) serve only the owner's `/start` flow. They
 *   are read from SSM on each request that needs them, so deleting or changing one takes effect at once, even in a
 *   warm environment. After linking, the owner deletes all three and `/start` is off; the refresh path never reads them.
 *
 * `SsmParameterClient` is the shape of the aggregated `SSM` client from `@aws-sdk/client-ssm`, which the Lambda
 * Node.js runtime provides. The role grants `ssm:GetParameter` and `ssm:GetParameters` on exactly these six ARNs.
 */

export const DEFAULT_SECRETS_PREFIX = '/youtrack-voice/link-broker/';

/** Parameter name suffixes for the token secrets, read at init. */
export const TOKEN_SECRET_NAMES = {
  youtrackClientSecret: 'youtrack-client-secret',
  brokerClientId: 'broker-client-id',
  brokerClientSecret: 'broker-client-secret',
} as const;

/** Parameter name suffixes for the setup secrets, read per request. */
export const SETUP_SECRET_NAMES = {
  setupKey: 'setup-key',
  lwaClientId: 'lwa-client-id',
  lwaClientSecret: 'lwa-client-secret',
} as const;

export type TokenSecrets = Readonly<Record<keyof typeof TOKEN_SECRET_NAMES, string>>;

export interface LwaClient {
  clientId: string;
  clientSecret: string;
}

/** The setup secrets, read when asked. `undefined` means the parameter does not exist (or is empty). */
export interface SetupSecrets {
  setupKey(): Promise<string | undefined>;
  lwaClient(): Promise<LwaClient | undefined>;
}

/**
 * The shortest broker client secret and setup key accepted: 32 characters (the runbook generates 64 hex characters).
 * A setup key shorter than this, or no setup key, turns `/start` off.
 */
export const MIN_GENERATED_SECRET_LENGTH = 32;

export interface SsmGetParameterInput {
  Name: string;
  WithDecryption: true;
}

export interface SsmGetParametersInput {
  Names: string[];
  WithDecryption: true;
}

export interface SsmParameterClient {
  getParameter(input: SsmGetParameterInput): Promise<{Parameter?: {Value?: unknown}}>;
  getParameters(
    input: SsmGetParametersInput,
  ): Promise<{Parameters?: {Name?: unknown; Value?: unknown}[]; InvalidParameters?: unknown[]}>;
}

const PREFIX = /^\/[A-Za-z0-9_.\-/]+\/$/;

/** The name SSM (and the AWS SDK v3) gives a parameter that does not exist. */
const NOT_FOUND = 'ParameterNotFound';

function requirePrefix(prefix: string): void {
  if (!PREFIX.test(prefix)) throw new Error('SECRETS_PREFIX must be an SSM path that starts and ends with /');
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Reads `names` (suffixes) in one decrypted `GetParameters` call. Returns the trimmed values by suffix; a name SSM
 * reports invalid, or an empty value, is absent from the result. SDK errors are rethrown naming the kind, never a value.
 */
async function getMany(
  client: SsmParameterClient,
  prefix: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  let result: Awaited<ReturnType<SsmParameterClient['getParameters']>>;
  try {
    result = await client.getParameters({Names: names.map((name) => `${prefix}${name}`), WithDecryption: true});
  } catch (error) {
    throw new Error(`could not read SSM parameters under ${prefix} (${errorKind(error)})`);
  }
  const values = new Map<string, string>();
  for (const parameter of result.Parameters ?? []) {
    if (typeof parameter.Name !== 'string' || typeof parameter.Value !== 'string') continue;
    if (!parameter.Name.startsWith(prefix) || parameter.Value.trim() === '') continue;
    values.set(parameter.Name.slice(prefix.length), parameter.Value.trim());
  }
  return values;
}

/**
 * Reads the token secrets, decrypted, in one call. Throws naming the parameter (never its value) when one is missing
 * or empty, or when the broker client secret is too short to be one the runbook generated.
 */
export async function loadTokenSecrets(client: SsmParameterClient, prefix: string): Promise<TokenSecrets> {
  requirePrefix(prefix);
  const values = await getMany(client, prefix, Object.values(TOKEN_SECRET_NAMES));
  const out: Record<string, string> = {};
  for (const [key, name] of Object.entries(TOKEN_SECRET_NAMES)) {
    const value = values.get(name);
    if (value === undefined) throw new Error(`SSM parameter ${prefix}${name} is missing or empty`);
    out[key] = value;
  }
  const secrets = out as TokenSecrets;
  if (secrets.brokerClientSecret.length < MIN_GENERATED_SECRET_LENGTH) {
    throw new Error(`SSM parameter ${prefix}${TOKEN_SECRET_NAMES.brokerClientSecret} is too short`);
  }
  return secrets;
}

/** The setup secrets over SSM, read fresh on every call. */
export function ssmSetupSecrets(client: SsmParameterClient, prefix: string): SetupSecrets {
  requirePrefix(prefix);
  return {
    async setupKey() {
      const name = `${prefix}${SETUP_SECRET_NAMES.setupKey}`;
      let value: unknown;
      try {
        value = (await client.getParameter({Name: name, WithDecryption: true})).Parameter?.Value;
      } catch (error) {
        if (errorKind(error) === NOT_FOUND) return undefined;
        throw new Error(`could not read SSM parameter ${name} (${errorKind(error)})`);
      }
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    },
    async lwaClient() {
      const values = await getMany(client, prefix, [
        SETUP_SECRET_NAMES.lwaClientId,
        SETUP_SECRET_NAMES.lwaClientSecret,
      ]);
      const clientId = values.get(SETUP_SECRET_NAMES.lwaClientId);
      const clientSecret = values.get(SETUP_SECRET_NAMES.lwaClientSecret);
      return clientId === undefined || clientSecret === undefined ? undefined : {clientId, clientSecret};
    },
  };
}

/** Whether a setup key read from SSM turns `/start` on: only one at least MIN_GENERATED_SECRET_LENGTH long. */
export function setupKeyUsable(setupKey: string | undefined): setupKey is string {
  return setupKey !== undefined && setupKey.length >= MIN_GENERATED_SECRET_LENGTH;
}
