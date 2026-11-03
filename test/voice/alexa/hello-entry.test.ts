import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {ACCOUNT_TOKEN, API_ACCESS_TOKEN, ENROLLED_PERSON_ID, loadEnvelope, PERSON_TOKEN, SKILL_ID} from './helpers.ts';

interface Line {
  level: string;
  event: string;
  [field: string]: unknown;
}

/** The hello entry reads its environment at import, so the Lambda-shaped module needs SKILL_ID set first. */
async function helloModule(t: TestContext) {
  const previous = process.env.SKILL_ID;
  process.env.SKILL_ID = SKILL_ID;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.SKILL_ID;
    } else {
      process.env.SKILL_ID = previous;
    }
  });
  return import('../../../src/voice/alexa/deploy/hello-entry.ts');
}

async function hello(t: TestContext, env: Record<string, string> = {}) {
  const {createHelloHandler} = await helloModule(t);
  const lines: string[] = [];
  const handler = createHelloHandler({env: {SKILL_ID, ...env}, write: (line) => lines.push(line)});
  t.after(() => {
    const written = lines.join('\n');
    for (const secret of [PERSON_TOKEN, ACCOUNT_TOKEN, API_ACCESS_TOKEN]) {
      assert.equal(written.includes(secret), false, `hello log contains ${secret}`);
    }
  });
  return {handler, lines, parsed: () => lines.map((line) => JSON.parse(line) as Line)};
}

test('launch: an invoked line before anything else, then the request line and the hello sentence', async (t) => {
  const h = await hello(t);
  const response = await h.handler(loadEnvelope('launch'));
  assert.match(response.response.outputSpeech?.ssml ?? '', /Hello\. Your tracker skill/);
  const events = h.parsed().map((line) => line.event);
  assert.deepEqual(events, ['alexa.hello.invoked', 'alexa.hello.request']);
  assert.deepEqual(h.parsed()[0], {
    ...h.parsed()[0],
    level: 'info',
    requestType: 'LaunchRequest',
    topLevelKeys: ['version', 'session', 'context', 'request'],
  });
});

test('an envelope without a timestamp is logged as invalid before the throw', async (t) => {
  const h = await hello(t);
  await assert.rejects(h.handler(loadEnvelope('launch-no-timestamp')), /request\.timestamp/);
  const lines = h.parsed();
  assert.deepEqual(
    lines.map((line) => [line.level, line.event]),
    [
      ['info', 'alexa.hello.invoked'],
      ['warn', 'alexa.hello.envelope.invalid'],
    ],
  );
});

test("a session ended with Amazon's error logs the error type at info and never the message", async (t) => {
  const h = await hello(t);
  await h.handler(loadEnvelope('session-ended-error'));
  const ended = h.parsed().find((line) => line.event === 'alexa.hello.sessionEnded');
  assert.equal(ended?.level, 'info');
  assert.equal(ended?.reason, 'ERROR');
  assert.equal(ended?.errorType, 'INVALID_RESPONSE');
  assert.equal(h.lines.join('\n').includes('secret summary'), false);
});

test('another skill is rejected with a line, even for an unsupported request type', async (t) => {
  const h = await hello(t);
  await assert.rejects(h.handler(loadEnvelope('wrong-application')), /not for this skill/);
  const foreign = loadEnvelope('wrong-application') as {request: {type: string}};
  foreign.request.type = 'System.ExceptionEncountered';
  await assert.rejects(h.handler(foreign), /not for this skill/);
  assert.equal(h.parsed().filter((line) => line.event === 'alexa.hello.application.rejected').length, 2);

  const own = loadEnvelope('launch') as {request: {type: string}};
  own.request.type = 'System.ExceptionEncountered';
  assert.deepEqual(await h.handler(own), {version: '1.0', response: {}});
});

test('a misconfigured environment logs why before failing', async (t) => {
  const {createHelloHandler} = await helloModule(t);
  const lines: string[] = [];
  assert.throws(() => createHelloHandler({env: {}, write: (line) => lines.push(line)}), /SKILL_ID is required/);
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as Line).event),
    ['alexa.hello.config.invalid'],
  );
});

test('enrolment log: exactly one info line carries the personId while ENROLMENT_LOG is on', async (t) => {
  const on = await hello(t, {ENROLMENT_LOG: 'true'});
  await on.handler(loadEnvelope('intent-person-match'));
  const carrying = on.lines.filter((line) => line.includes(ENROLLED_PERSON_ID));
  assert.equal(carrying.length, 1);
  assert.equal((JSON.parse(carrying[0] ?? '{}') as Line).event, 'alexa.enrolment.person');
  assert.equal(on.lines.join('\n').includes('<speak>'), false);
  assert.equal(on.lines.join('\n').includes('in-progress'), false);

  const off = await hello(t);
  await off.handler(loadEnvelope('intent-person-match'));
  assert.equal(off.lines.join('\n').includes(ENROLLED_PERSON_ID), false);
});
