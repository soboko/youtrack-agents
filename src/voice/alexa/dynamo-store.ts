/**
 * UserStateStore over DynamoDB (YA-14). The state string is opaque: the core owns and versions its shape, so this
 * table never needs a migration. One item per speaker, keyed by the namespaced userId, with a TTL so state for a
 * speaker who stops using the skill is removed by DynamoDB itself.
 *
 * Saves are optimistic (contract revision 1): each item carries a numeric `version`, and a save is a conditional put
 * that succeeds only if the stored version is still the one the turn loaded. A turn that outlived its deadline, or a
 * second device, therefore cannot silently overwrite a newer save; its save returns `false` instead.
 *
 * No AWS SDK import here, since adding dependencies is outside this stream. `DynamoItemClient` is the shape of the
 * aggregated client in `@aws-sdk/client-dynamodb` (`new DynamoDB({})` has `getItem` and `putItem` returning
 * promises), which the Lambda Node.js runtimes already include. Conditional puts need no IAM action beyond PutItem.
 */
import type {StoredState, UserStateStore} from '../core/types.ts';

export interface DynamoGetItemInput {
  TableName: string;
  Key: Record<string, {S: string}>;
  ConsistentRead?: boolean;
}

export interface DynamoPutItemInput {
  TableName: string;
  Item: Record<string, {S: string} | {N: string}>;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, {N: string}>;
}

/** The two calls the store makes. Output items are read defensively, so the SDK's wider types fit. */
export interface DynamoItemClient {
  getItem(input: DynamoGetItemInput): Promise<{Item?: Record<string, unknown>}>;
  putItem(input: DynamoPutItemInput): Promise<unknown>;
}

export interface DynamoStoreOptions {
  client: DynamoItemClient;
  tableName: string;
  /** How long an untouched speaker's state lives. */
  ttlSeconds: number;
  now: () => number;
}

/** Item attribute names. The table template (deploy/template.yaml) declares the key and TTL attributes to match. */
export const ATTRIBUTE = {
  key: 'userId',
  state: 'state',
  version: 'version',
  updatedAt: 'updatedAt',
  expiresAt: 'expiresAt',
} as const;

/**
 * DynamoDB's item limit is 400 KB including attribute names. State far below that is expected; anything near it is
 * a core bug, refused loudly rather than failing inside DynamoDB with a less clear error.
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html
 */
export const MAX_STATE_BYTES = 350_000;

export class StateTooLargeError extends Error {
  constructor(bytes: number) {
    super(`serialized voice state is ${bytes} bytes, over the ${MAX_STATE_BYTES}-byte limit`);
    this.name = 'StateTooLargeError';
  }
}

/** The name DynamoDB (and the AWS SDK v3) gives a failed condition. */
const CONDITION_FAILED = 'ConditionalCheckFailedException';

export function createDynamoStore(options: DynamoStoreOptions): UserStateStore {
  const {client, tableName} = options;

  return {
    async load(userId): Promise<StoredState | null> {
      requireUserId(userId);
      const result = await client.getItem({
        TableName: tableName,
        Key: {[ATTRIBUTE.key]: {S: userId}},
        ConsistentRead: true,
      });
      const item = result.Item;
      if (!item) return null;

      // DynamoDB deletes expired items within days, not instantly, so an expired item can still be read. It counts as
      // nothing stored, and the save condition below lets a `null` expectation replace it.
      const expiresAt = numberAttribute(item[ATTRIBUTE.expiresAt]);
      if (expiresAt !== undefined && expiresAt * 1000 <= options.now()) return null;

      const serialized = stringAttribute(item[ATTRIBUTE.state]);
      const version = numberAttribute(item[ATTRIBUTE.version]);
      if (serialized === undefined || version === undefined) return null;
      return {serialized, version: String(version)};
    },

    async save(userId, serialized, expectedVersion) {
      requireUserId(userId);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > MAX_STATE_BYTES) throw new StateTooLargeError(bytes);

      const nowMs = options.now();
      const nowSeconds = Math.floor(nowMs / 1000);
      const expected = expectedVersion === null ? null : parseVersion(expectedVersion);
      const next = expected === null ? 1 : expected + 1;

      const condition: Pick<
        DynamoPutItemInput,
        'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
      > =
        expected === null
          ? // Nothing stored, or what load() reports as nothing: an expired item DynamoDB has not deleted yet, or an
            // item with no version.
            {
              ConditionExpression: 'attribute_not_exists(#key) OR attribute_not_exists(#version) OR #expiresAt <= :now',
              ExpressionAttributeNames: {
                '#key': ATTRIBUTE.key,
                '#version': ATTRIBUTE.version,
                '#expiresAt': ATTRIBUTE.expiresAt,
              },
              ExpressionAttributeValues: {':now': {N: String(nowSeconds)}},
            }
          : {
              ConditionExpression: '#version = :expected',
              ExpressionAttributeNames: {'#version': ATTRIBUTE.version},
              ExpressionAttributeValues: {':expected': {N: String(expected)}},
            };

      try {
        await client.putItem({
          TableName: tableName,
          Item: {
            [ATTRIBUTE.key]: {S: userId},
            [ATTRIBUTE.state]: {S: serialized},
            [ATTRIBUTE.version]: {N: String(next)},
            [ATTRIBUTE.updatedAt]: {N: String(nowMs)},
            [ATTRIBUTE.expiresAt]: {N: String(nowSeconds + options.ttlSeconds)},
          },
          ...condition,
        });
      } catch (error) {
        // The SDK throws a ConditionalCheckFailedException, identified by name; anything else is a real failure.
        if (typeof error === 'object' && error !== null && (error as {name?: unknown}).name === CONDITION_FAILED) {
          return false;
        }
        throw error;
      }
      return true;
    },
  };
}

/** Versions this store issues are positive integers as strings; anything else is a caller bug. */
function parseVersion(version: string): number {
  if (!/^[1-9]\d{0,15}$/.test(version)) throw new Error('expectedVersion is not a version this store issued');
  return Number(version);
}

function requireUserId(userId: string): void {
  if (userId === '') throw new Error('userId must not be empty');
}

function stringAttribute(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as {S?: unknown}).S;
  return typeof text === 'string' ? text : undefined;
}

function numberAttribute(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const text = (value as {N?: unknown}).N;
  if (typeof text !== 'string') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
