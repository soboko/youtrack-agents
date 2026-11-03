import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDynamoStore,
  MAX_STATE_BYTES,
  StateTooLargeError,
  type DynamoGetItemInput,
  type DynamoItemClient,
  type DynamoPutItemInput,
} from '../../../src/voice/alexa/dynamo-store.ts';
import {FIXTURE_TIME} from './helpers.ts';

type Item = Record<string, {S: string} | {N: string}>;

function number(item: Item | undefined, name: string): number | undefined {
  const value = item?.[name];
  return value && 'N' in value ? Number(value.N) : undefined;
}

/**
 * An in-memory table that evaluates the store's two condition expressions the way DynamoDB would, and throws
 * DynamoDB's ConditionalCheckFailedException when one fails.
 */
function fakeTable() {
  const items = new Map<string, Item>();
  const gets: DynamoGetItemInput[] = [];
  const puts: DynamoPutItemInput[] = [];
  const client: DynamoItemClient = {
    getItem: async (input) => {
      gets.push(input);
      const item = items.get(input.Key.userId?.S ?? '');
      return item ? {Item: item} : {};
    },
    putItem: async (input) => {
      puts.push(input);
      const key = input.Item.userId;
      if (!key || !('S' in key)) throw new Error('missing key');
      const current = items.get(key.S);
      let allowed: boolean;
      if (
        input.ConditionExpression ===
        'attribute_not_exists(#key) OR attribute_not_exists(#version) OR #expiresAt <= :now'
      ) {
        const now = Number(input.ExpressionAttributeValues[':now']?.N);
        allowed =
          !current || number(current, 'version') === undefined || (number(current, 'expiresAt') ?? Infinity) <= now;
      } else if (input.ConditionExpression === '#version = :expected') {
        allowed = number(current, 'version') === Number(input.ExpressionAttributeValues[':expected']?.N);
      } else {
        throw new Error(`unexpected condition ${input.ConditionExpression}`);
      }
      if (!allowed)
        throw Object.assign(new Error('The conditional request failed'), {name: 'ConditionalCheckFailedException'});
      items.set(key.S, input.Item);
      return {};
    },
  };
  return {client, items, gets, puts};
}

const USER = 'alexa:person:amzn1.ask.person.ENROLLEDHOUSEHOLDMEMBER';

test('a first save is conditional on nothing stored, and loads back with its version', async () => {
  let now = FIXTURE_TIME;
  const table = fakeTable();
  const store = createDynamoStore({client: table.client, tableName: 'voice-state', ttlSeconds: 86_400, now: () => now});

  assert.equal(await store.load(USER), null);
  assert.equal(await store.save(USER, '{"v":1,"workingSet":["YA-12"]}', null), true);

  const seconds = Math.floor(FIXTURE_TIME / 1000);
  assert.deepEqual(table.puts[0], {
    TableName: 'voice-state',
    Item: {
      userId: {S: USER},
      state: {S: '{"v":1,"workingSet":["YA-12"]}'},
      version: {N: '1'},
      updatedAt: {N: String(FIXTURE_TIME)},
      expiresAt: {N: String(seconds + 86_400)},
    },
    ConditionExpression: 'attribute_not_exists(#key) OR attribute_not_exists(#version) OR #expiresAt <= :now',
    ExpressionAttributeNames: {'#key': 'userId', '#version': 'version', '#expiresAt': 'expiresAt'},
    ExpressionAttributeValues: {':now': {N: String(seconds)}},
  });
  now += 60_000;
  assert.deepEqual(await store.load(USER), {serialized: '{"v":1,"workingSet":["YA-12"]}', version: '1'});
  assert.deepEqual(table.gets.at(-1), {TableName: 'voice-state', Key: {userId: {S: USER}}, ConsistentRead: true});
});

test('a save expecting the loaded version succeeds once; the stale one returns false and writes nothing', async () => {
  const now = FIXTURE_TIME;
  const table = fakeTable();
  const store = createDynamoStore({client: table.client, tableName: 't', ttlSeconds: 3600, now: () => now});
  await store.save(USER, 'turn-0', null);

  // Two overlapping turns both loaded version 1.
  const slow = await store.load(USER);
  const fast = await store.load(USER);
  assert.equal(await store.save(USER, 'fast turn', fast?.version ?? null), true);
  assert.equal(await store.save(USER, 'slow turn', slow?.version ?? null), false);
  assert.deepEqual(await store.load(USER), {serialized: 'fast turn', version: '2'});
  assert.equal(table.puts.at(-1)?.ConditionExpression, '#version = :expected');
  assert.deepEqual(table.puts.at(-1)?.ExpressionAttributeValues, {':expected': {N: '1'}});

  // A turn that thought nothing was stored also loses.
  assert.equal(await store.save(USER, 'blind', null), false);
});

test('an item past its TTL reads as empty, and a null-expectation save may replace it', async () => {
  let now = FIXTURE_TIME;
  const table = fakeTable();
  const store = createDynamoStore({client: table.client, tableName: 't', ttlSeconds: 10, now: () => now});
  await store.save(USER, 'state', null);
  now += 10_000;
  assert.equal(await store.load(USER), null);
  assert.equal(await store.save(USER, 'fresh', null), true);
  assert.deepEqual(await store.load(USER), {serialized: 'fresh', version: '1'});
});

test('a malformed item reads as empty rather than throwing, and can be replaced', async () => {
  const table = fakeTable();
  table.items.set(USER, {userId: {S: USER}, state: {N: '3'}});
  const store = createDynamoStore({client: table.client, tableName: 't', ttlSeconds: 10, now: () => FIXTURE_TIME});
  assert.equal(await store.load(USER), null);
  assert.equal(await store.save(USER, 'repaired', null), true);
});

test('refuses oversized state, empty user ids and versions it never issued', async () => {
  const table = fakeTable();
  const store = createDynamoStore({client: table.client, tableName: 't', ttlSeconds: 10, now: () => FIXTURE_TIME});
  await assert.rejects(store.save(USER, 'é'.repeat(MAX_STATE_BYTES / 2 + 1), null), StateTooLargeError);
  await assert.rejects(store.load(''), /userId must not be empty/);
  await assert.rejects(store.save(USER, 'x', 'v7'), /not a version this store issued/);
  assert.equal(table.puts.length, 0);
});

test('a condition failure resolves false by name; any other DynamoDB error still rejects', async () => {
  const table = fakeTable();
  const store = createDynamoStore({client: table.client, tableName: 't', ttlSeconds: 10, now: () => FIXTURE_TIME});
  table.client.putItem = async () => {
    // Deliberately not an Error: the store must recognise the failure by name whatever shape the client throws.
    throw Object.assign(Object.create(null) as object, {name: 'ConditionalCheckFailedException'});
  };
  assert.equal(await store.save(USER, 'x', null), false);
  table.client.putItem = async () => {
    throw Object.assign(new Error('Throughput exceeded'), {name: 'ProvisionedThroughputExceededException'});
  };
  await assert.rejects(store.save(USER, 'x', null), /Throughput exceeded/);
});
