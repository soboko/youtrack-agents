import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {inspect} from 'node:util';
import {loadConfig} from '../../src/config.ts';
import {YouTrackTransport, providerDetail} from '../../src/youtrack/transport.ts';
import {createClient} from '../../src/youtrack/client.ts';

const config = loadConfig(
  {baseUrl: 'https://tracker.example', project: 'YA', token: 'private-token'},
  {environment: {}, files: []},
);

test('provider bodies and network errors cannot expose credentials; writes are not retried', async () => {
  let calls = 0;
  const transport = new YouTrackTransport(config, {
    fetch: async () => {
      calls++;
      return new Response('private-token and confidential issue', {status: 500});
    },
  });
  await assert.rejects(transport.request('POST', 'issues', {}), (error: unknown) => {
    assert.equal((error as {kind: string}).kind, 'unknown');
    assert.doesNotMatch(String(error), /private-token|confidential/);
    return true;
  });
  assert.equal(calls, 1);
});

test('timeout bounds even a fetch implementation that ignores abort', async (context) => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0;
  const transport = new YouTrackTransport(config, {
    timeoutMs: 10,
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => {});
    },
  });
  const result = assert.rejects(transport.request('POST', 'issues', {}), {kind: 'unknown'});
  context.mock.timers.tick(10);
  await result;
  assert.equal(calls, 1);
});

test('collections page beyond historical caps and honor explicit limits', async () => {
  const skips: number[] = [];
  const transport = new YouTrackTransport(config, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const skip = Number(url.searchParams.get('$skip'));
      const top = Number(url.searchParams.get('$top'));
      skips.push(skip);
      return Response.json(Array.from({length: Math.min(top, 230 - skip)}, (_, index) => skip + index));
    },
  });
  assert.equal((await transport.collect('issues')).length, 230);
  assert.deepEqual(skips, [0, 100, 200]);
  assert.equal((await transport.collect('issues', {}, 140)).length, 140);
});

test('API root escapes reject before credentials are sent; redirects are disabled', async () => {
  let calls = 0;
  const transport = new YouTrackTransport(config, {
    fetch: async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      return Response.json({id: 'x'});
    },
  });
  await assert.rejects(transport.request('GET', '../other'), {kind: 'validation'});
  assert.equal(calls, 0);
  await transport.request('GET', 'issues');
});

test('R-T6/T7/T11 malformed 200 bodies: collections and writes', async () => {
  const t = (body: unknown) =>
    new YouTrackTransport(config, {
      fetch: async () => (typeof body === 'string' ? new Response(body, {status: 200}) : Response.json(body)),
    });
  await assert.rejects(t({not: 'an array'}).collect('issues'), {kind: 'unavailable'});
  await assert.rejects(t(Array.from({length: 101}, () => 1)).collect('issues'), {kind: 'unavailable'});
  await assert.rejects(t('<html>proxy</html>').request('POST', 'issues', {}), {kind: 'unknown'});
});

test('R-T9/T10 status classification', async () => {
  for (const [status, kind] of [
    [401, 'permission'],
    [403, 'permission'],
    [404, 'not-found'],
    [409, 'conflict'],
    [412, 'conflict'],
    [400, 'validation'],
    [503, 'unavailable'],
  ] as const) {
    const t = new YouTrackTransport(config, {fetch: async () => new Response('{"error":"x"}', {status})});
    await assert.rejects(t.request('GET', 'issues'), {kind});
  }
});

test('R-T12 error objects never carry provider bodies', async () => {
  const t = new YouTrackTransport(config, {fetch: async () => new Response('private-token', {status: 400})});
  await assert.rejects(t.request('GET', 'issues'), (error: {body?: string}) => {
    assert.doesNotMatch(JSON.stringify(error) + String(error.body), /private-token/);
    return true;
  });
});

test('a write with an empty or unparseable 200, or a lost reply, is neither confirmed nor refused', async () => {
  const replies: Array<() => Response> = [
    () => new Response('', {status: 200}),
    () => new Response('<html>proxy</html>', {status: 200}),
    () => {
      throw new Error('socket hang up');
    },
  ];
  const transport = new YouTrackTransport(config, {fetch: async () => replies.shift()!()});
  assert.equal(await transport.request('POST', 'issues', {}), null);
  await assert.rejects(transport.request('POST', 'issues', {}), {kind: 'unknown'});
  await assert.rejects(transport.request('POST', 'issues', {}), {kind: 'unknown'});
  assert.deepEqual(transport.writes, {dispatched: 3, confirmed: 0, refused: 0});
  await assert.rejects(transport.request('POST', '../escape', {}), {kind: 'validation'});
  assert.deepEqual(transport.writes, {dispatched: 3, confirmed: 0, refused: 0});
});

/** A fake collection of `total` numbered items that honours `$top`/`$skip` and records each page request. */
function numbered(total: number) {
  const tops: number[] = [];
  const transport = new YouTrackTransport(config, {
    fetch: async (input) => {
      const url = new URL(String(input));
      const skip = Number(url.searchParams.get('$skip'));
      const top = Number(url.searchParams.get('$top'));
      tops.push(top);
      return Response.json(Array.from({length: Math.max(0, Math.min(top, total - skip))}, (_, index) => skip + index));
    },
  });
  return {transport, tops};
}

test('B1 a capped collection fetches one item past the limit and says whether more exist', async () => {
  const more = numbered(5);
  assert.deepEqual(await more.transport.collectPage('issues', {}, 3), {values: [0, 1, 2], truncated: true});
  assert.deepEqual(more.tops, [4]);
  const exact = numbered(3);
  assert.deepEqual(await exact.transport.collectPage('issues', {}, 3), {values: [0, 1, 2], truncated: false});
  const paged = numbered(250);
  const page = await paged.transport.collectPage('issues', {}, 150);
  assert.equal(page.values.length, 150);
  assert.equal(page.truncated, true);
  assert.deepEqual(paged.tops, [100, 51]);
  const none = numbered(1);
  assert.deepEqual(await none.transport.collectPage('issues', {}, 0), {values: [], truncated: true});
  await assert.rejects(none.transport.collectPage('issues', {}, -1), {
    kind: 'validation',
    message: 'Collection limit must be a nonnegative integer',
  });
});

test('B1 an uncapped collection of exactly the safety limit is complete; one more fails with the limit message', async () => {
  assert.equal((await numbered(100_000).transport.collect('issues')).length, 100_000);
  await assert.rejects(numbered(100_001).transport.collect('issues'), {
    kind: 'unavailable',
    message: 'Collection safety limit reached; inventory incomplete',
  });
});

test('B1 page-size and shape failures carry their messages', async () => {
  const t = (body: unknown) => new YouTrackTransport(config, {fetch: async () => Response.json(body)});
  await assert.rejects(t(Array.from({length: 5}, () => 1)).collectPage('issues', {}, 3), {
    kind: 'unavailable',
    message: 'Provider ignored collection page size',
  });
  await assert.rejects(t({}).collectPage('issues', {}, 3), {
    kind: 'unavailable',
    message: 'Expected a YouTrack collection',
  });
});

test('B9 a write answered 408, 499 or an unmapped 4xx is unknown; mapped refusals stay refusals', async () => {
  for (const status of [408, 499, 429, 418, 451]) {
    const transport = new YouTrackTransport(config, {fetch: async () => new Response('{}', {status})});
    await assert.rejects(transport.request('POST', 'issues', {}), {kind: 'unknown', status});
    assert.deepEqual(transport.writes, {dispatched: 1, confirmed: 0, refused: 0}, `write ${status}`);
    await assert.rejects(transport.request('GET', 'issues'), {kind: 'unavailable', status});
  }
  for (const [status, kind] of [
    [400, 'validation'],
    [401, 'permission'],
    [403, 'permission'],
    [404, 'not-found'],
    [409, 'conflict'],
    [412, 'conflict'],
    [422, 'validation'],
  ] as const) {
    const transport = new YouTrackTransport(config, {fetch: async () => new Response('{}', {status})});
    await assert.rejects(transport.request('POST', 'issues', {}), {kind, status});
    assert.deepEqual(transport.writes, {dispatched: 1, confirmed: 0, refused: 1}, `write ${status}`);
  }
});

test('B10 debug detail keeps the provider error and description, truncated, with credentials stripped', async () => {
  const body = {
    error: 'invalid_query',
    error_description: `Bad value near private-token and perm:YWRtaW4=.NDQtMA==.secret ${'x'.repeat(400)}`,
    issue: 'confidential issue text',
  };
  const transport = new YouTrackTransport(config, {fetch: async () => Response.json(body, {status: 400})});
  await assert.rejects(transport.request('GET', 'issues'), (error: {detail: string; message: string}) => {
    assert.match(error.detail, /^invalid_query: Bad value near \[token\] and \[token\] x+\.\.\.$/);
    assert.equal(error.detail.length, 303);
    assert.doesNotMatch(error.detail, /private-token|secret|confidential/);
    assert.equal(error.message, 'YouTrack HTTP 400');
    assert.doesNotMatch(JSON.stringify(error), /invalid_query|private-token/);
    return true;
  });
  const html = new YouTrackTransport(config, {
    fetch: async () => new Response('<html>private-token</html>', {status: 502}),
  });
  await assert.rejects(html.request('GET', 'issues'), {detail: ''});
});

test('B6/Y7 a token that is missing or cannot be sent in a header is refused before anything is dispatched', () => {
  const {token: _token, ...spread} = {...config};
  for (const bad of ['private\r\nX-Injected: 1', 'two words', 'café', '', undefined]) {
    let calls = 0;
    // A hand-built or spread config is typed as Config but need not hold a usable token.
    const handBuilt = {...spread, token: bad} as unknown as typeof config;
    assert.throws(
      () =>
        new YouTrackTransport(handBuilt, {
          fetch: async () => {
            calls++;
            return Response.json({});
          },
        }),
      (error: Error & {kind: string}) => {
        assert.equal(error.kind, 'validation');
        assert.ok(bad === undefined || bad === '' || !error.message.includes(bad));
        return true;
      },
    );
    assert.equal(calls, 0);
  }
  // Spreading a loaded config drops its hidden token; the client refuses it instead of sending `Bearer undefined`.
  assert.throws(() => createClient({model: 't', session: 't'}, {config: {...config}}), {kind: 'validation'});
});

// YA-25 Y7: B3's https rule holds for a config that did not come from loadConfig.
test('Y7 a hand-built config with a cleartext remote URL is refused; loopback http is allowed', () => {
  const build = (baseUrl: string) => Object.assign({...config, baseUrl}, {token: 'private-token'});
  for (const baseUrl of [
    'http://tracker.example',
    'http://localhost.evil.example',
    'https://u:p@tracker.example',
    'nonsense',
  ]) {
    assert.throws(() => new YouTrackTransport(build(baseUrl)), {kind: 'validation'}, baseUrl);
  }
  for (const baseUrl of ['https://tracker.example', 'http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:9']) {
    assert.doesNotThrow(() => new YouTrackTransport(build(baseUrl)), baseUrl);
  }
});

test('B11 the transport never serialises its credential', () => {
  const transport = new YouTrackTransport(config, {fetch: async () => Response.json({})});
  assert.doesNotMatch(JSON.stringify(transport), /private-token/);
  assert.doesNotMatch(inspect(transport, {depth: 5, showHidden: false}), /private-token/);
  assert.doesNotMatch(JSON.stringify({...transport}), /private-token/);
});

// YA-25 Y2: a provider may echo the token transformed; detail strips every form, and leaves ordinary prose alone.
test('Y2 debug detail strips the token in any case, without its prefix, by component, and encoded', () => {
  const token = 'perm:ZmFrZQ==.NDQtMA==.FAKEsecretFAKEsecret123';
  const secret = 'FAKEsecretFAKEsecret123';
  const leaks: Record<string, string> = {
    exact: token,
    'uppercase prefix': `PERM:${token.slice(5)}`,
    'fully uppercased': token.toUpperCase(),
    'without prefix': token.slice(5),
    'secret part only': `bad signature ${secret}`,
    'lowercased secret': secret.toLowerCase(),
    'base64 of token': Buffer.from(token).toString('base64'),
    'base64url of token': Buffer.from(token).toString('base64url'),
    'url-encoded token': encodeURIComponent(token),
    'zero-width after prefix': `perm:\u200b${token.slice(5)}`,
    'json-escaped colon': 'perm\\u003a' + token.slice(5),
    'split by newline': `${token.slice(0, 20)}\n${token.slice(20)}`,
    'near the truncation limit': 'x'.repeat(290) + token,
  };
  for (const [label, value] of Object.entries(leaks)) {
    const detail = providerDetail(JSON.stringify({error: 'invalid_token', error_description: value}), token);
    for (const form of [
      token,
      secret,
      token.slice(5),
      Buffer.from(token).toString('base64'),
      encodeURIComponent(token),
    ]) {
      assert.ok(!detail.toLowerCase().includes(form.toLowerCase()), `${label}: ${detail}`);
    }
    assert.ok(detail.startsWith('invalid_token: '), label);
  }
  const prose: Record<string, string> = {
    'field error': "Unknown field 'Priority' in project YA",
    'words that share short token parts': 'the private token perm was rejected',
    'an id and a url': 'Issue 2-17 at https://tracker.example/issue/YA-1 is locked',
  };
  for (const [label, value] of Object.entries(prose)) {
    const detail = providerDetail(JSON.stringify({error: 'e', error_description: value}), 'private-token');
    assert.equal(detail, `e: ${value}`, label);
  }
});
