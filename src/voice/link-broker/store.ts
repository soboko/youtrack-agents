/**
 * The link table (YA-33): pending flows (keyed by their `state`) and one-time codes, each a sealed payload with an
 * expiry. DynamoDB, with the same no-SDK-import approach as `alexa/dynamo-store.ts`: `LinkItemClient` is the shape of
 * the aggregated `DynamoDB` client from `@aws-sdk/client-dynamodb`, which the Lambda runtime provides.
 *
 * Single use is enforced by DynamoDB, not by the handler: `take` is one conditional `DeleteItem` that returns the old
 * item, so of two concurrent redemptions of the same state or code exactly one gets the item and the other gets null.
 * Its condition also refuses an item whose `expiresAt` has passed, because DynamoDB's TTL deletes expired items within
 * days, not at once. `put` refuses to overwrite an existing id.
 */

export interface LinkRecord {
  /** The sealed payload (crypto.ts `seal`). The table never holds a plaintext token, code, verifier or state. */
  sealed: string;
  /** Epoch seconds. The TTL attribute, and the upper bound `take` enforces. */
  expiresAt: number;
}

export interface LinkStore {
  /** Stores a new record. Throws if the id already exists. */
  put(id: string, record: LinkRecord): Promise<void>;
  /** Deletes and returns the record if it exists and has not expired; otherwise null. Atomic. */
  take(id: string): Promise<LinkRecord | null>;
  /** Deletes the record if present. For cleanup after a failed flow. */
  discard(id: string): Promise<void>;
}

type Attribute = {S: string} | {N: string};

export interface LinkPutItemInput {
  TableName: string;
  Item: Record<string, Attribute>;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
}

export interface LinkDeleteItemInput {
  TableName: string;
  Key: Record<string, {S: string}>;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, {N: string}>;
  ReturnValues?: 'ALL_OLD' | 'NONE';
}

/** The two calls the store makes. Output items are read defensively, so the SDK's wider types fit. */
export interface LinkItemClient {
  putItem(input: LinkPutItemInput): Promise<unknown>;
  deleteItem(input: LinkDeleteItemInput): Promise<{Attributes?: Record<string, unknown>}>;
}

/** Attribute names; the template's LinkTable declares the key and the TTL attribute to match. */
export const LINK_ATTRIBUTE = {id: 'id', sealed: 'sealed', expiresAt: 'expiresAt'} as const;

/** The name DynamoDB (and the AWS SDK v3) gives a failed condition. */
const CONDITION_FAILED = 'ConditionalCheckFailedException';

export class RecordExistsError extends Error {
  constructor() {
    super('a link record with this id already exists');
    this.name = 'RecordExistsError';
  }
}

function isConditionFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as {name?: unknown}).name === CONDITION_FAILED;
}

export interface DynamoLinkStoreOptions {
  client: LinkItemClient;
  tableName: string;
  now: () => number;
}

export function createDynamoLinkStore(options: DynamoLinkStoreOptions): LinkStore {
  const {client, tableName} = options;

  return {
    async put(id, record) {
      requireId(id);
      try {
        await client.putItem({
          TableName: tableName,
          Item: {
            [LINK_ATTRIBUTE.id]: {S: id},
            [LINK_ATTRIBUTE.sealed]: {S: record.sealed},
            [LINK_ATTRIBUTE.expiresAt]: {N: String(record.expiresAt)},
          },
          ConditionExpression: 'attribute_not_exists(#id)',
          ExpressionAttributeNames: {'#id': LINK_ATTRIBUTE.id},
        });
      } catch (error) {
        if (isConditionFailure(error)) throw new RecordExistsError();
        throw error;
      }
    },

    async take(id) {
      requireId(id);
      let result: {Attributes?: Record<string, unknown>};
      try {
        result = await client.deleteItem({
          TableName: tableName,
          Key: {[LINK_ATTRIBUTE.id]: {S: id}},
          ConditionExpression: 'attribute_exists(#id) AND #expiresAt > :now',
          ExpressionAttributeNames: {'#id': LINK_ATTRIBUTE.id, '#expiresAt': LINK_ATTRIBUTE.expiresAt},
          ExpressionAttributeValues: {':now': {N: String(Math.floor(options.now() / 1000))}},
          ReturnValues: 'ALL_OLD',
        });
      } catch (error) {
        if (isConditionFailure(error)) return null;
        throw error;
      }
      const item = result.Attributes;
      if (item === undefined) return null;
      const sealed = stringAttribute(item[LINK_ATTRIBUTE.sealed]);
      const expiresAt = numberAttribute(item[LINK_ATTRIBUTE.expiresAt]);
      if (sealed === undefined || expiresAt === undefined) return null;
      return {sealed, expiresAt};
    },

    async discard(id) {
      requireId(id);
      await client.deleteItem({TableName: tableName, Key: {[LINK_ATTRIBUTE.id]: {S: id}}, ReturnValues: 'NONE'});
    },
  };
}

function requireId(id: string): void {
  if (id === '') throw new Error('link record id must not be empty');
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
