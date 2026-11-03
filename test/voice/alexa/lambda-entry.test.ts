import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLambdaHandler,
  DYNAMO_CLIENT_CONFIG,
  stateTtlSeconds,
  type LambdaEntryOptions,
} from '../../../src/voice/alexa/deploy/lambda-entry.ts';
import type {DynamoGetItemInput, DynamoItemClient, DynamoPutItemInput} from '../../../src/voice/alexa/dynamo-store.ts';
import type {ResponseEnvelope} from '../../../src/voice/alexa/envelope.ts';
import {idTag} from '../../../src/voice/alexa/log.ts';
import type {VoiceTracker} from '../../../src/voice/core/types.ts';
import {createFakeYouTrack, FAKE_BASE_URL, type FakeIssue} from '../binding/fake-youtrack.ts';
import {
  ACCOUNT_TOKEN,
  API_ACCESS_TOKEN,
  ENROLLED_PERSON_ID,
  deferred,
  FakeClock,
  FIXTURE_TIME,
  loadEnvelope,
  PERSON_TOKEN,
  SKILL_ID,
} from './helpers.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The household deploy (OD1 option B), with debug logs so the token checks cover every line. */
const ENV = {
  SKILL_ID,
  ENROLLED_PERSON_ID,
  READ_ACCEPTS: 'person,account',
  WRITE_ACCEPTS: 'person',
  ACCOUNT_TOKEN_FALLBACK: 'true',
  CARDS: 'off',
  ENROLMENT_LOG: 'false',
  LOG_LEVEL: 'debug',
  STATE_TABLE: 'youtrack-voice-StateTable',
  STATE_TTL_DAYS: '30',
  YOUTRACK_URL: FAKE_BASE_URL,
  YOUTRACK_PROJECT: 'H',
  HOUSEHOLD_LOGIN: 'household',
};

const ISSUES: FakeIssue[] = [
  {
    key: 'H-7',
    summary: 'Book the boiler service',
    state: 'Open',
    assignee: 'household',
    updated: FIXTURE_TIME - DAY_MS,
  },
  {
    key: 'H-4',
    summary: 'Fix the kitchen tap',
    state: 'In Progress',
    assignee: 'household',
    updated: FIXTURE_TIME - 3 * DAY_MS,
    comments: [
      {
        author: 'owner',
        fullName: 'Chris',
        created: Date.parse('2026-09-01T09:00:00Z'),
        text: 'Washers are in the drawer.',
      },
      {author: 'sam', fullName: 'Sam Okafor', created: Date.parse('2026-09-02T09:00:00Z'), text: 'Still drips.'},
    ],
  },
  {key: 'H-2', summary: 'Renew the car tax', state: 'Open', assignee: 'sam', updated: FIXTURE_TIME - 5 * DAY_MS},
  {
    key: 'YA-3',
    summary: 'Agent work on the boiler parser',
    state: 'Open',
    assignee: 'household',
    updated: FIXTURE_TIME,
  },
];

interface Line {
  level: string;
  event: string;
  [field: string]: unknown;
}

/** DynamoDB's conditional put, in a Map: enough of `getItem`/`putItem` for `dynamo-store.ts`. */
function fakeDynamo() {
  const items = new Map<string, Record<string, {S: string} | {N: string}>>();
  const calls: Array<{op: 'get' | 'put'; input: DynamoGetItemInput | DynamoPutItemInput}> = [];
  const client: DynamoItemClient = {
    getItem: async (input) => {
      calls.push({op: 'get', input});
      const item = items.get(input.Key.userId.S);
      return item === undefined ? {} : {Item: structuredClone(item)};
    },
    putItem: async (input) => {
      calls.push({op: 'put', input});
      const key = (input.Item.userId as {S: string}).S;
      const current = items.get(key);
      const version = current === undefined ? undefined : (current.version as {N: string}).N;
      const expected = input.ExpressionAttributeValues[':expected']?.N;
      const ok = expected === undefined ? version === undefined : version === expected;
      if (!ok) throw Object.assign(new Error('condition'), {name: 'ConditionalCheckFailedException'});
      items.set(key, structuredClone(input.Item));
      return {};
    },
  };
  return {client, items, calls};
}

interface EnvelopeOptions {
  base?: string;
  intent?: {name: string; slots?: Record<string, string>};
  attributes?: Record<string, unknown>;
  requestId: string;
}

/** A fixture envelope turned into the next turn of a session: a new request id, intent and carried attributes. */
function envelope(options: EnvelopeOptions): Record<string, unknown> {
  const event = loadEnvelope(options.base ?? 'launch') as {
    session: {new: boolean; attributes: Record<string, unknown>};
    request: Record<string, unknown>;
  };
  if (options.attributes !== undefined) {
    event.session.new = false;
    event.session.attributes = options.attributes;
  }
  const request = {...event.request, requestId: options.requestId};
  if (options.intent !== undefined) {
    const slots = Object.fromEntries(
      Object.entries(options.intent.slots ?? {}).map(([name, value]) => [
        name,
        {name, value, confirmationStatus: 'NONE'},
      ]),
    );
    Object.assign(request, {
      type: 'IntentRequest',
      dialogState: 'COMPLETED',
      intent: {name: options.intent.name, confirmationStatus: 'NONE', slots},
    });
  }
  event.request = request;
  return event;
}

function speech(response: ResponseEnvelope): string {
  return (response.response.outputSpeech?.ssml ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface EntryFixture {
  /** Token -> YouTrack account, beyond the household account and Sam's. */
  accounts?: Array<[string, {login: string; fullName: string}]>;
  /** Wraps the fake YouTrack's fetch, e.g. to hold a request. */
  wrapFetch?: (base: typeof fetch) => typeof fetch;
}

async function entry(overrides: Partial<LambdaEntryOptions> = {}, fixture: EntryFixture = {}) {
  const lines: string[] = [];
  const alexaCalls: string[] = [];
  const waiters: Array<{event: string; count: number; done: () => void}> = [];
  const countOf = (event: string) => lines.filter((line) => (JSON.parse(line) as Line).event === event).length;
  const youtrack = createFakeYouTrack({
    accounts: new Map([
      [ACCOUNT_TOKEN, {login: 'household', fullName: 'Household'}],
      [PERSON_TOKEN, {login: 'sam', fullName: 'Sam'}],
      ...(fixture.accounts ?? []),
    ]),
    issues: ISSUES,
    otherHost: async (url, init) => {
      alexaCalls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
      if (url.pathname.endsWith('/settings/System.timeZone')) return Response.json('Europe/London');
      return new Response(null, {status: 204});
    },
  });
  const dynamo = fakeDynamo();
  const clock = new FakeClock(FIXTURE_TIME);
  const handler = await createLambdaHandler({
    env: ENV,
    write: (line) => {
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (countOf(waiter.event) >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.done();
        }
      }
    },
    dynamo: dynamo.client,
    fetch: fixture.wrapFetch ? fixture.wrapFetch(youtrack.fetch) : youtrack.fetch,
    clock,
    ...overrides,
  });
  const parsed = () => lines.map((line) => JSON.parse(line) as Line);
  /** Resolves once `count` lines of `event` have been written: for work the binding does beside a turn. */
  const waitForEvent = (event: string, count = 1): Promise<void> =>
    countOf(event) >= count
      ? Promise.resolve()
      : new Promise((done) => {
          waiters.push({event, count, done});
        });
  return {handler, lines, parsed, youtrack, dynamo, alexaCalls, clock, waitForEvent};
}

/** An envelope whose account-level link carries `token`. */
function withAccountToken(event: Record<string, unknown>, token: string): Record<string, unknown> {
  const typed = event as {context: {System: {user: {accessToken: string}}}; session: {user: {accessToken: string}}};
  typed.context.System.user.accessToken = token;
  typed.session.user.accessToken = token;
  return event;
}

test('end to end: launch, my issues, open, comments and a search, read from project H through the full entry', async (t) => {
  const h = await entry();
  t.after(() => {
    const written = h.lines.join('\n');
    for (const secret of [
      ACCOUNT_TOKEN,
      PERSON_TOKEN,
      API_ACCESS_TOKEN,
      'ACCOUNT-TOKEN-SECRET',
      'PERSON-TOKEN-SECRET',
    ]) {
      assert.equal(written.includes(secret), false, `a log line contains ${secret}`);
    }
  });
  const context = {awsRequestId: 'aws-request-1'};

  const launch = await h.handler(envelope({requestId: 'amzn1.echo-api.request.T1'}), context);
  assert.match(speech(launch), /\S/);
  assert.deepEqual(
    h.youtrack.requests.map((request) => request.path),
    ['/api/users/me'],
    'a launch reads no issue, but checks the account-level link against HOUSEHOLD_LOGIN first',
  );

  const list = await h.handler(
    envelope({
      requestId: 'amzn1.echo-api.request.T2',
      intent: {name: 'ListIntent', slots: {scope: 'mine'}},
      attributes: launch.sessionAttributes ?? {},
    }),
    context,
  );
  const listed = speech(list);
  assert.match(listed, /Book the boiler service/);
  assert.match(listed, /Fix the kitchen tap/);
  assert.doesNotMatch(listed, /car tax|parser/, 'only my issues, only in project H');

  const opened = await h.handler(
    envelope({
      requestId: 'amzn1.echo-api.request.T3',
      intent: {name: 'OpenIntent', slots: {ordinal: '2'}},
      attributes: list.sessionAttributes ?? {},
    }),
    context,
  );
  assert.match(speech(opened), /Fix the kitchen tap/);

  const comments = await h.handler(
    envelope({
      requestId: 'amzn1.echo-api.request.T4',
      intent: {name: 'ReadIntent', slots: {part: 'comments'}},
      attributes: opened.sessionAttributes ?? {},
    }),
    context,
  );
  assert.match(speech(comments), /Comment 1 of 2, from Chris, on 1 September\. Washers are in the drawer\./);

  const more = await h.handler(
    envelope({
      requestId: 'amzn1.echo-api.request.T4b',
      intent: {name: 'AMAZON.NextIntent'},
      attributes: comments.sessionAttributes ?? {},
    }),
    context,
  );
  assert.match(speech(more), /Comment 2 of 2, from Sam Okafor, on 2 September\. Still drips\./, 'oldest comment first');

  const found = await h.handler(
    envelope({
      requestId: 'amzn1.echo-api.request.T5',
      intent: {name: 'FindIntent', slots: {words: 'boiler please'}},
      attributes: more.sessionAttributes ?? {},
    }),
    context,
  );
  assert.match(speech(found), /Book the boiler service/);
  assert.doesNotMatch(speech(found), /parser/);

  // Every tracker request: a GET, with the account link's token, scoped to H, never the B14 board or placement routes.
  const requests = h.youtrack.requests;
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /api/users/me', // the launch's link check, remembered for the token
      'GET /api/issues', // my issues
      'GET /api/issues/H-4', // open 2
      'GET /api/issues/H-4', // read the comments: the core re-reads the issue, then its comments
      'GET /api/issues/H-4/comments',
      'GET /api/issues/H-4', // more
      'GET /api/issues/H-4/comments',
      'GET /api/issues', // find
    ],
  );
  assert.ok(requests.every((request) => request.authorization === `Bearer ${ACCOUNT_TOKEN}`));
  const queries = requests.filter((request) => request.path === '/api/issues').map((request) => request.query.query);
  assert.deepEqual(queries, [
    'project: H for: me #Unresolved sort by: updated desc',
    'project: H (summary: "boiler" or summary: "please") sort by: updated desc',
  ]);
  assert.equal(h.alexaCalls.filter((call) => call.startsWith('GET ')).length, 1, 'time zone once per session');

  // State went to the table under the account link's key, versioned.
  assert.deepEqual([...h.dynamo.items.keys()], ['alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT']);
  const item = h.dynamo.items.get('alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT');
  assert.ok(item);
  assert.equal(Number((item.version as {N: string}).N) >= 3, true);
  assert.ok(h.dynamo.calls.every((call) => call.input.TableName === 'youtrack-voice-StateTable'));
  assert.equal((item.expiresAt as {N: string}).N, String(Math.floor(FIXTURE_TIME / 1000) + 30 * 86_400));

  const lines = h.parsed();
  const ready = lines.find((line) => line.event === 'alexa.entry.ready');
  assert.deepEqual(ready, {...ready, level: 'info', stateTtlDays: 30, dynamo: 'injected', tracker: 'youtrack'});
  const linked = lines.filter((line) => line.event === 'voice.binding.linked');
  assert.equal(linked.length, 1, 'the bound login is logged once for the link');
  assert.deepEqual(linked[0], {...linked[0], level: 'info', project: 'H', loginTag: idTag('household')});
  assert.equal(
    lines.some((line) => line.event === 'alexa.turn.failed'),
    false,
  );
});

test('two envelopes, two tokens: each turn reaches YouTrack with its own token only (YA-14 judgement D5)', async () => {
  const h = await entry();
  const person = await h.handler(envelope({base: 'intent-person-match', requestId: 'amzn1.echo-api.request.P1'}));
  assert.match(speech(person), /\S/);
  // A person's own link logs its login beside the turn rather than before it.
  await h.waitForEvent('voice.binding.linked');
  const personRequests = h.youtrack.requests.length;
  assert.ok(personRequests > 0);

  await h.handler(
    envelope({requestId: 'amzn1.echo-api.request.A1', intent: {name: 'ListIntent', slots: {scope: 'open'}}}),
  );
  const tokens = h.youtrack.requests.map((request) => request.authorization);
  assert.deepEqual(new Set(tokens.slice(0, personRequests)), new Set([`Bearer ${PERSON_TOKEN}`]));
  assert.deepEqual(new Set(tokens.slice(personRequests)), new Set([`Bearer ${ACCOUNT_TOKEN}`]));
  assert.deepEqual(
    h
      .parsed()
      .filter((line) => line.event === 'voice.binding.linked')
      .map((line) => line.loginTag),
    [idTag('sam'), idTag('household')],
  );
});

test('a revoked account-level link (401 on the link check) is spoken as relink, and the token stays out of every line', async () => {
  const h = await entry();
  const revoked = 'Atza|REVOKED-ACCOUNT-SECRET-9';
  const event = withAccountToken(
    envelope({requestId: 'amzn1.echo-api.request.R1', intent: {name: 'ListIntent', slots: {scope: 'mine'}}}),
    revoked,
  );
  const response = await h.handler(event);
  assert.match(speech(response), /link has expired or was removed/);
  assert.equal(response.response.card?.type, 'LinkAccount');
  assert.equal(h.lines.join('\n').includes('REVOKED-ACCOUNT-SECRET'), false);
  assert.equal(h.youtrack.requests.filter((request) => request.path === '/api/issues').length, 0);
  const failed = h.parsed().find((line) => line.event === 'alexa.turn.failed');
  assert.deepEqual(failed, {...failed, failure: 'unauthorized', status: 401});
});

test("a person's own revoked link: the core catches the 401 and says the tracker refused (relinking there is YA-28)", async () => {
  const h = await entry();
  const event = envelope({
    base: 'intent-person-match',
    requestId: 'amzn1.echo-api.request.R2',
  }) as {context: {System: {person: {accessToken: string}}}};
  event.context.System.person.accessToken = 'Atza|REVOKED-PERSON-SECRET-8';
  const response = await h.handler(event as unknown as Record<string, unknown>);
  assert.match(speech(response), /wouldn't let me read that/);
  await h.waitForEvent('voice.binding.linkUnconfirmed');
  assert.equal(h.lines.join('\n').includes('REVOKED-PERSON-SECRET'), false);
});

test('an account-level link to any account but HOUSEHOLD_LOGIN is told to relink and reads nothing (review K1)', async () => {
  const ownerToken = 'Atza|OWNER-ADMIN-SECRET-7';
  const h = await entry({}, {accounts: [[ownerToken, {login: 'chris', fullName: 'Chris Owner'}]]});
  const launch = await h.handler(withAccountToken(envelope({requestId: 'amzn1.echo-api.request.K1'}), ownerToken));
  assert.match(speech(launch), /link has expired or was removed/);
  const list = await h.handler(
    withAccountToken(
      envelope({requestId: 'amzn1.echo-api.request.K2', intent: {name: 'ListIntent', slots: {scope: 'open'}}}),
      ownerToken,
    ),
  );
  assert.match(speech(list), /link has expired or was removed/);
  assert.doesNotMatch(speech(list), /boiler|tap|car tax/);
  assert.deepEqual(
    h.youtrack.requests.map((request) => request.path),
    ['/api/users/me'],
    'one login lookup, remembered for the token; no issue read',
  );
  const mismatches = h.parsed().filter((line) => line.event === 'voice.binding.loginMismatch');
  assert.equal(mismatches.length, 2);
  assert.deepEqual(mismatches[0], {
    ...mismatches[0],
    level: 'warn',
    requestId: 'amzn1.echo-api.request.K1',
    linkedVia: 'account',
    loginTag: idTag('chris'),
    expectedTag: idTag('household'),
  });
  const failed = h.parsed().filter((line) => line.event === 'alexa.turn.failed');
  assert.deepEqual(
    failed.map((line) => [line.failure, line.errorName]),
    [
      ['unauthorized', 'LinkMismatchError'],
      ['unauthorized', 'LinkMismatchError'],
    ],
  );
  const aboveDebug = h.lines.filter((line) => (JSON.parse(line) as Line).level !== 'debug').join('\n');
  assert.equal(aboveDebug.includes('chris'), false, 'the login only as a tag above debug');
  assert.equal(h.lines.join('\n').includes('OWNER-ADMIN-SECRET'), false);
  assert.equal(h.dynamo.items.size, 0, 'nothing saved for a refused link');
});

test("the turn's deadline aborts a YouTrack request still in flight (review F11/K5)", async () => {
  const started = deferred<void>();
  let abortedPath: string | undefined;
  const h = await entry(
    {},
    {
      wrapFetch: (base) => async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname !== '/api/issues') return base(input, init);
        started.resolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedPath = url.pathname;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      },
    },
  );
  const pending = h.handler(
    envelope({requestId: 'amzn1.echo-api.request.D1', intent: {name: 'ListIntent', slots: {scope: 'mine'}}}),
  );
  await started.promise;
  assert.equal(abortedPath, undefined);
  h.clock.advanceTo(FIXTURE_TIME + 7000);
  const response = await pending;
  assert.match(speech(response), /taking too long|too long/);
  assert.equal(abortedPath, '/api/issues', 'the handler signal reached the request on the wire');
});

test("interleaved turns for two links: every request carries its own turn's token and each hears only its own list (review K8)", async () => {
  // Every YouTrack response waits for a varying number of other requests to arrive, so turns interleave.
  const gates: Array<() => void> = [];
  let arrived = 0;
  const h = await entry(
    {},
    {
      wrapFetch: (base) => async (input, init) => {
        const position = arrived++;
        await new Promise<void>((release) => {
          gates.push(release);
          if (gates.length >= 2 || position % 3 === 0) for (const open of gates.splice(0)) open();
        });
        return base(input, init);
      },
    },
  );
  const turns = Array.from({length: 12}, (_unused, n) => {
    const person = n % 2 === 0;
    const base = person ? 'intent-person-match' : 'launch';
    const event = envelope({
      base,
      requestId: `amzn1.echo-api.request.I${n}`,
      intent: {name: 'ListIntent', slots: {scope: 'mine'}},
    });
    return {person, response: h.handler(event)};
  });
  // Release anything still parked once every turn has started.
  const drain = setInterval(() => {
    for (const open of gates.splice(0)) open();
  }, 1);
  try {
    for (const turn of turns) {
      const heard = speech(await turn.response);
      if (turn.person) {
        assert.match(heard, /Renew the car tax/);
        assert.doesNotMatch(heard, /boiler|kitchen/);
      } else {
        assert.match(heard, /Book the boiler service/);
        assert.doesNotMatch(heard, /car tax/);
      }
    }
  } finally {
    clearInterval(drain);
  }
  const byToken = new Map<string | null, string[]>();
  for (const request of h.youtrack.requests) {
    byToken.set(request.authorization, [...(byToken.get(request.authorization) ?? []), request.query.query ?? '']);
  }
  assert.deepEqual([...byToken.keys()].sort(), [`Bearer ${ACCOUNT_TOKEN}`, `Bearer ${PERSON_TOKEN}`].sort());
});

test('startFailed never writes a secret from the environment or the error (review K8)', async () => {
  const secrets = {
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-SECRET-ACCESS-KEY',
    AWS_SESSION_TOKEN: 'IQoJb3JpZ2luX2VjE-SESSION-TOKEN',
    YOUTRACK_TOKEN: 'perm:AMBIENT-YOUTRACK-TOKEN',
  };
  const failures: Array<Partial<LambdaEntryOptions> & {env: Record<string, string | undefined>}> = [
    {env: {...ENV, ...secrets, YOUTRACK_URL: 'https://user:perm:AMBIENT-YOUTRACK-TOKEN@x.example'}},
    {env: {...ENV, ...secrets, HOUSEHOLD_LOGIN: undefined}},
    {
      env: {...ENV, ...secrets},
      dynamo: undefined,
      loadDynamoSdk: async () => {
        throw new Error("Cannot find package '@aws-sdk/client-dynamodb'");
      },
    },
  ];
  for (const failure of failures) {
    const lines: string[] = [];
    let thrown = '';
    try {
      await createLambdaHandler({
        dynamo: fakeDynamo().client,
        clock: new FakeClock(FIXTURE_TIME),
        write: (line) => lines.push(line),
        ...failure,
      });
    } catch (error) {
      thrown = String(error instanceof Error ? error.stack : error);
    }
    assert.notEqual(thrown, '');
    assert.equal(
      lines.some((line) => (JSON.parse(line) as Line).event === 'alexa.entry.startFailed'),
      true,
    );
    for (const secret of Object.values(secrets)) {
      assert.equal(lines.join('\n').includes(secret), false, secret);
      assert.equal(thrown.includes(secret), false, secret);
    }
  }
});

test('the DynamoDB client comes from the SDK module with two attempts and short timeouts', async () => {
  const constructed: unknown[] = [];
  class DynamoDB implements DynamoItemClient {
    constructor(config: unknown) {
      constructed.push(config);
    }

    async getItem(): Promise<{Item?: Record<string, unknown>}> {
      return {};
    }

    async putItem(): Promise<unknown> {
      return {};
    }
  }
  const h = await entry({dynamo: undefined, loadDynamoSdk: async () => ({DynamoDB})});
  assert.deepEqual(constructed, [{maxAttempts: 2, requestHandler: {requestTimeout: 1000, connectionTimeout: 500}}]);
  assert.deepEqual(DYNAMO_CLIENT_CONFIG, constructed[0]);
  const response = await h.handler(envelope({requestId: 'amzn1.echo-api.request.S1'}));
  assert.match(speech(response), /\S/);
  assert.equal(h.parsed().find((line) => line.event === 'alexa.entry.ready')?.dynamo, 'sdk');
});

test('a misconfigured entry logs why and refuses to start, naming variables and never values', async () => {
  const cases: Array<[Record<string, string | undefined>, Partial<LambdaEntryOptions>, RegExp]> = [
    [{STATE_TABLE: undefined}, {}, /STATE_TABLE is required/],
    [{STATE_TTL_DAYS: '0'}, {}, /STATE_TTL_DAYS/],
    [{YOUTRACK_URL: undefined}, {}, /YOUTRACK_URL is required/],
    [{YOUTRACK_URL: 'http://tracker.example'}, {}, /YOUTRACK_URL must be https/],
    [{YOUTRACK_PROJECT: 'H or YA'}, {}, /YOUTRACK_PROJECT/],
    [{SKILL_ID: undefined}, {}, /SKILL_ID is required/],
    [{HOUSEHOLD_LOGIN: undefined}, {}, /HOUSEHOLD_LOGIN is required when ACCOUNT_TOKEN_FALLBACK=true/],
    [{HOUSEHOLD_LOGIN: 'house hold'}, {}, /HOUSEHOLD_LOGIN must be a YouTrack login/],
    [{}, {dynamo: undefined, loadDynamoSdk: async () => ({})}, /does not export a DynamoDB client/],
    [
      {},
      {
        dynamo: undefined,
        loadDynamoSdk: async () => {
          throw Object.assign(new Error("Cannot find package '@aws-sdk/client-dynamodb'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        },
      },
      /Cannot find package/,
    ],
  ];
  for (const [change, options, expected] of cases) {
    const lines: string[] = [];
    const env: Record<string, string | undefined> = {...ENV, ...change};
    await assert.rejects(
      createLambdaHandler({
        env,
        write: (line) => lines.push(line),
        dynamo: fakeDynamo().client,
        clock: new FakeClock(FIXTURE_TIME),
        ...options,
      }),
      expected,
    );
    const failed = lines
      .map((line) => JSON.parse(line) as Line)
      .find((line) => line.event === 'alexa.entry.startFailed');
    assert.equal(failed?.level, 'error');
    assert.match(String(failed?.problem), expected);
    assert.equal(lines.join('\n').includes('tracker.example'), false);
  }
});

test('an injected tracker replaces the binding, for the compiled-entry smoke run', async () => {
  const seen: string[] = [];
  const tracker: VoiceTracker = {
    listIssues: async () => ({issues: [], complete: true}),
    getIssue: async () => {
      throw new Error('unused');
    },
    listComments: async () => ({comments: [], complete: true}),
    listAssignees: async () => ({people: [], complete: true}),
  };
  const h = await entry({
    env: {...ENV, YOUTRACK_URL: undefined},
    trackerFor: (token) => {
      seen.push(token);
      return tracker;
    },
  });
  const response = await h.handler(
    envelope({requestId: 'amzn1.echo-api.request.I1', intent: {name: 'ListIntent', slots: {scope: 'mine'}}}),
  );
  assert.match(speech(response), /\S/);
  assert.deepEqual(seen, [ACCOUNT_TOKEN]);
  assert.equal(h.youtrack.requests.length, 0);
});

test('STATE_TTL_DAYS: whole days from 1 to 365, 90 by default', () => {
  assert.equal(stateTtlSeconds({}), 90 * 86_400);
  assert.equal(stateTtlSeconds({STATE_TTL_DAYS: ' '}), 90 * 86_400);
  assert.equal(stateTtlSeconds({STATE_TTL_DAYS: '365'}), 365 * 86_400);
  for (const bad of ['0', '366', '1.5', 'ninety', '-3']) {
    assert.throws(() => stateTtlSeconds({STATE_TTL_DAYS: bad}), /STATE_TTL_DAYS/);
  }
});

test('YA-36 end to end: an unlinked "air quality" through the full entry, from the device postal code, key never logged', async () => {
  const key = 'PA-READ-KEY-CANARY-ENTRY-0b9d';
  const calls: string[] = [];
  const seen = Math.floor(FIXTURE_TIME / 1000) - 180;
  const airFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    if (url.pathname.endsWith('/countryAndPostalCode')) return Response.json({countryCode: 'US', postalCode: '59802'});
    if (url.host === 'api.purpleair.com' && url.pathname === '/v1/keys') {
      assert.equal(new Headers(init?.headers).get('X-API-Key'), key);
      return Response.json({api_version: 'V1.0.15', api_key_type: 'READ'});
    }
    if (url.host === 'api.purpleair.com') {
      assert.equal(new Headers(init?.headers).get('X-API-Key'), key);
      return Response.json({
        fields: ['sensor_index', 'latitude', 'longitude', 'last_seen', 'humidity', 'pm2.5_10minute'],
        data: [
          [11, 46.905, -113.97, seen, 30, 25],
          [12, 46.906, -113.971, seen, 31, 24],
          [13, 46.904, -113.969, seen, 29, 26],
        ],
      });
    }
    return new Response(null, {status: 404});
  }) as typeof fetch;
  const h = await entry({
    env: {...ENV, AIR_QUALITY: 'on', HOME_LOCATION: '46.87,-113.99'},
    fetch: airFetch,
    loadSsmSdk: async () => ({
      SSM: class {
        async getParameter(input: {Name: string}) {
          assert.equal(input.Name, '/youtrack-voice/purpleair/read-key');
          return {Parameter: {Value: key}};
        }
      },
    }),
    loadGeoPlacesSdk: async () => ({
      GeoPlaces: class {
        async geocode() {
          return {
            ResultItems: [
              {
                PlaceType: 'PostalCode',
                Position: [-113.97, 46.905],
                Address: {PostalCode: '59802'},
                MatchScores: {Overall: 1},
              },
            ],
          };
        }
      },
    }),
  });
  const event = loadEnvelope('intent-no-token') as {request: Record<string, unknown>};
  event.request = {...event.request, intent: {name: 'AirQualityIntent', confirmationStatus: 'NONE', slots: {}}};
  const response = await h.handler(event);

  assert.match(
    speech(response),
    /^Air quality near you is Moderate\. AQI \d+, from a 10-minute average from 1 PurpleAir sensor, 1 metre away, updated 3 minutes ago\./,
  );
  assert.deepEqual(calls, [
    'GET api.eu.amazonalexa.com/v1/devices/amzn1.ask.device.KITCHENECHO/settings/address/countryAndPostalCode',
    'GET api.purpleair.com/v1/keys',
    'GET api.purpleair.com/v1/sensors',
    'GET api.purpleair.com/v1/sensors',
  ]);
  assert.equal(speech(response).includes('5 9 8 0 2'), false, "the device's postal code is never spoken");
  assert.equal(h.youtrack.requests.length, 0, 'no tracker call without a link');
  const saved = [...h.dynamo.items.keys()];
  assert.deepEqual(saved, ['alexa:user:amzn1.ask.account.HOUSEHOLDACCOUNT:unlinked']);
  const written = h.lines.join('\n');
  assert.equal(written.includes(key), false, 'the PurpleAir key is never logged, even at debug');
  assert.equal(written.includes(API_ACCESS_TOKEN), false);
});

test('YA-36 review C1: a garbage HOME_LOCATION (or AIR_QUALITY) never takes down the skill: "my issues" still reads', async () => {
  for (const env of [
    {...ENV, AIR_QUALITY: 'on', HOME_LOCATION: '46.8,-1139'},
    {...ENV, AIR_QUALITY: 'off', HOME_LOCATION: '59802'},
    {...ENV, AIR_QUALITY: 'On', HOME_LOCATION: '!!!'},
  ]) {
    const h = await entry({env});
    const list = await h.handler(
      envelope({requestId: 'amzn1.echo-api.request.C1', intent: {name: 'ListIntent', slots: {scope: 'mine'}}}),
    );
    assert.match(speech(list), /Book the boiler service/, JSON.stringify({air: env.AIR_QUALITY}));
    const warned = h.parsed().filter((line) => line.level === 'warn' && String(line.event).startsWith('air.'));
    if (env.AIR_QUALITY === 'off') assert.equal(warned.length, 0, 'with air quality off, nothing about it runs');
    else assert.ok(warned.length === 1, `one warn line, got ${JSON.stringify(warned)}`);
    assert.equal(h.lines.join('\n').includes('1139'), false, 'the value is never logged');
  }
});
