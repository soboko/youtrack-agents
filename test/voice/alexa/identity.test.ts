/**
 * YA-21 (YA-14 Judge follow-up F1, finding N1): within one Alexa session, a turn must never read a working set that
 * was saved under a different tracker identity. Option B lets unrecognised voices read with the account-level link,
 * so a session can mix a person-level token and the account-level token.
 *
 * The fake core below keeps a working set the way the real core does (list saves the keys it read, open resolves an
 * ordinal against the stored list and fetches that key), and each fake tracker knows only its own account's issues, so
 * an ordinal resolved against another identity's list is visible as a cross-identity fetch.
 */
import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {AlexaSkillConfig} from '../../../src/voice/alexa/config.ts';
import type {ResponseEnvelope} from '../../../src/voice/alexa/envelope.ts';
import {createHandler} from '../../../src/voice/alexa/handler.ts';
import type {TrackerIssue} from '../../../src/tracker.ts';
import type {ConversationDeps, VoiceRequest, VoiceResponse, VoiceTracker} from '../../../src/voice/core/types.ts';
import {
  ACCOUNT_TOKEN,
  captureLog,
  FakeClock,
  FIXTURE_TIME,
  loadEnvelope,
  memoryStore,
  PERSON_TOKEN,
  recordingFetch,
  testConfig,
} from './helpers.ts';

const BOUNDED = {timeout: 5000};

/** OD1 as the owner decided it: household-wide reads through the account link. */
const OPTION_B: Partial<AlexaSkillConfig> = {
  accountTokenFallback: true,
  policy: {...testConfig().policy, readAccepts: ['person', 'account']},
};

const OTHER_PERSON_TOKEN = 'Atza|OTHER-PERSON-LINK';

/** Each linked YouTrack account owns different issues, in list order, so every list and every item says whose it is. */
const ISSUES_BY_TOKEN: Readonly<Record<string, readonly string[]>> = {
  [ACCOUNT_TOKEN]: ['HOUSE-1', 'HOUSE-2', 'HOUSE-3'],
  [PERSON_TOKEN]: ['MINE-1', 'MINE-2', 'MINE-3'],
  [OTHER_PERSON_TOKEN]: ['OTHER-1', 'OTHER-2', 'OTHER-3'],
};

function issue(key: string): TrackerIssue {
  const workflow = {state: null, role: null, assignee: null, recommendedModel: null, subsystem: null};
  return {id: key, key, summary: `Summary of ${key}`, description: null, url: '', updated: 0, workflow};
}

interface Fetched {
  token: string;
  key: string;
  owned: boolean;
}

function household(t: TestContext) {
  const store = memoryStore();
  const fetched: Fetched[] = [];
  const handler = createHandler({
    config: testConfig(OPTION_B),
    trackerFor: (token): VoiceTracker => {
      const own = ISSUES_BY_TOKEN[token] ?? [];
      return {
        listIssues: async () => ({issues: own.map(issue), complete: true}),
        getIssue: async (key) => {
          fetched.push({token, key, owned: own.includes(key)});
          if (!own.includes(key)) throw Object.assign(new Error('Not Found'), {status: 404});
          return issue(key);
        },
        listComments: async () => ({comments: [], complete: true}),
        listAssignees: async () => ({people: [], complete: true}),
      };
    },
    converse: (request, deps) => fakeCore(request, deps),
    store,
    log: captureLog().log,
    clock: new FakeClock(FIXTURE_TIME),
    fetch: recordingFetch().fetch,
  });
  t.after(() => {
    const crossed = fetched.filter((entry) => !entry.owned);
    assert.deepEqual(crossed, [], 'a turn fetched an issue from a list read under another tracker identity');
  });
  return {handler, store, fetched};
}

/** list: read and store the keys. open: resolve the ordinal against the stored list and fetch it. */
async function fakeCore(request: VoiceRequest, deps: ConversationDeps): Promise<VoiceResponse> {
  const userId = request.speaker.userId;
  const stored = await deps.store.load(userId);
  const input = request.input;
  const say = (text: string): VoiceResponse => ({
    segments: [{text}],
    listen: true,
    reprompt: [{text: 'Say a number.'}],
    ratePercent: 100,
  });
  if (input.kind === 'intent' && input.intent === 'list') {
    const {issues} = await deps.tracker.listIssues({limit: 3});
    await deps.store.save(userId, JSON.stringify(issues.map((item) => item.key)), stored?.version ?? null);
    return say(`List: ${issues.map((item) => item.key).join(', ')}.`);
  }
  if (input.kind === 'intent' && input.intent === 'open') {
    const list = stored ? (JSON.parse(stored.serialized) as string[]) : [];
    const key = list[Number(input.slots.ordinal) - 1];
    if (key === undefined) return say('There is no list to open from.');
    const opened = await deps.tracker.getIssue(key);
    return say(`Opened ${opened.key}.`);
  }
  return say('OK.');
}

function speech(response: ResponseEnvelope): string {
  return (response.response.outputSpeech?.ssml ?? '').replace(/<[^>]+>/g, ' ').trim();
}

interface Envelope {
  session: {new: boolean; sessionId: string; attributes: Record<string, unknown>};
  request: {requestId: string; intent: {name: string; slots: Record<string, unknown>}};
  context: {System: {person?: {personId: string; accessToken?: string}}};
}

function turn(
  voice: 'enrolled' | 'enrolled-account-link' | 'unrecognised' | 'other-person',
  intent: 'list' | 'open',
  session: {id: string; after?: ResponseEnvelope},
): Envelope {
  const base =
    voice === 'unrecognised'
      ? 'intent-no-person'
      : voice === 'other-person'
        ? 'intent-person-other'
        : 'intent-person-match';
  const envelope = loadEnvelope(base) as unknown as Envelope;
  if (voice === 'enrolled-account-link') delete envelope.context.System.person?.accessToken;
  if (voice === 'other-person' && envelope.context.System.person) {
    envelope.context.System.person.accessToken = OTHER_PERSON_TOKEN;
  }
  envelope.request.requestId = `amzn1.echo-api.request.${voice}-${intent}-${Math.random().toString(36).slice(2, 8)}`;
  envelope.request.intent =
    intent === 'list'
      ? {name: 'ListIntent', slots: {scope: {name: 'scope', value: 'mine'}}}
      : {name: 'OpenIntent', slots: {ordinal: {name: 'ordinal', value: '2'}}};
  envelope.session.sessionId = `amzn1.echo-api.session.${session.id}`;
  envelope.session.new = session.after === undefined;
  envelope.session.attributes = session.after?.sessionAttributes ?? {};
  return envelope;
}

test(
  "the Judge's N1 sequence: an unrecognised 'open 2' never opens from the account's older list",
  BOUNDED,
  async (t) => {
    const h = household(t);
    // Yesterday: an unrecognised voice listed the household account's issues.
    await h.handler(turn('unrecognised', 'list', {id: 'yesterday'}));
    // Today: the enrolled person, recognised with their own link, lists their own issues.
    const heard = await h.handler(turn('enrolled', 'list', {id: 'today'}));
    assert.match(speech(heard), /MINE-1, MINE-2, MINE-3/);
    // Same session, Voice ID misses: "open 2" arrives unrecognised, with the account link.
    const opened = await h.handler(turn('unrecognised', 'open', {id: 'today', after: heard}));

    assert.doesNotMatch(speech(opened), /HOUSE-2/, 'opened an item from a list the listener did not just hear');
    assert.match(speech(opened), /no list to open from/);
  },
);

test(
  'the opposite direction: a recognised turn after an unrecognised one does not load the account list',
  BOUNDED,
  async (t) => {
    const h = household(t);
    // An earlier session: the enrolled person's own list.
    await h.handler(turn('enrolled', 'list', {id: 'earlier'}));
    // Now: an unrecognised voice lists the household account's issues.
    const heard = await h.handler(turn('unrecognised', 'list', {id: 'now'}));
    assert.match(speech(heard), /HOUSE-1, HOUSE-2, HOUSE-3/);
    // Same session, the enrolled person is recognised this time and says "open 2".
    const opened = await h.handler(turn('enrolled', 'open', {id: 'now', after: heard}));

    assert.doesNotMatch(speech(opened), /HOUSE-2/, 'loaded the account list under a person link');
    assert.doesNotMatch(speech(opened), /MINE-2/, 'opened from an older list than the one just heard');
    assert.match(speech(opened), /no list to open from/);
  },
);

test(
  'same tracker identity in one session still continues: enrolled voice on the account link, then unrecognised',
  BOUNDED,
  async (t) => {
    const h = household(t);
    const heard = await h.handler(turn('enrolled-account-link', 'list', {id: 's'}));
    assert.match(speech(heard), /HOUSE-1, HOUSE-2, HOUSE-3/);
    const opened = await h.handler(turn('unrecognised', 'open', {id: 's', after: heard}));
    assert.match(speech(opened), /Opened HOUSE-2/);

    const again = await h.handler(turn('unrecognised', 'open', {id: 's', after: opened}));
    assert.match(speech(again), /Opened HOUSE-2/);
  },
);

test('two recognised people with their own links never share a record within a session', BOUNDED, async (t) => {
  const h = household(t);
  await h.handler(turn('other-person', 'list', {id: 'before'}));
  const heard = await h.handler(turn('enrolled', 'list', {id: 's'}));
  const opened = await h.handler(turn('other-person', 'open', {id: 's', after: heard}));
  assert.doesNotMatch(speech(opened), /MINE-2|OTHER-2/);
});

test('a fresh start is per session and identity: the next turn of that identity continues it', BOUNDED, async (t) => {
  const h = household(t);
  const heard = await h.handler(turn('enrolled', 'list', {id: 's'}));
  const refused = await h.handler(turn('unrecognised', 'open', {id: 's', after: heard}));
  assert.match(speech(refused), /no list to open from/);
  const listed = await h.handler(turn('unrecognised', 'list', {id: 's', after: refused}));
  assert.match(speech(listed), /HOUSE-1, HOUSE-2, HOUSE-3/);
  const opened = await h.handler(turn('unrecognised', 'open', {id: 's', after: listed}));
  assert.match(speech(opened), /Opened HOUSE-2/);

  // The fresh record did not overwrite the account's own long-lived list.
  const persisted = [...h.store.data.keys()];
  assert.ok(
    persisted.some((key) => key.includes(':session:')),
    persisted.join(' | '),
  );
});

test(
  'across sessions, the enrolled person keeps separate records for their own link and the account link',
  BOUNDED,
  async (t) => {
    const h = household(t);
    await h.handler(turn('enrolled', 'list', {id: 'one'}));
    await h.handler(turn('enrolled-account-link', 'list', {id: 'two'}));
    const opened = await h.handler(turn('enrolled', 'open', {id: 'three'}));
    assert.match(speech(opened), /Opened MINE-2/);
    const openedViaAccount = await h.handler(turn('enrolled-account-link', 'open', {id: 'four'}));
    assert.match(speech(openedViaAccount), /Opened HOUSE-2/);
  },
);
