import assert from 'node:assert/strict';
import test from 'node:test';
import type {AdapterCapabilities, SpeechSegment, VoiceResponse} from '../../../src/voice/core/types.ts';
import {MAX_SPEECH_CHARS} from '../../../src/voice/alexa/config.ts';
import {MESSAGES} from '../../../src/voice/alexa/messages.ts';
import {
  adapterResponse,
  clampRate,
  EARCON_SOUNDS,
  emptyResponse,
  escapeXml,
  fittingPrefix,
  renderResponse,
  renderSsml,
} from '../../../src/voice/alexa/response.ts';

const SPEAKER: AdapterCapabilities = {
  ssml: true,
  earcons: true,
  display: false,
  followUp: true,
  maxSpeechChars: MAX_SPEECH_CHARS,
};
const SCREEN: AdapterCapabilities = {...SPEAKER, display: true};
const NO_CARDS = {fallbackReprompt: MESSAGES.genericReprompt, cards: false};
const CARDS = {fallbackReprompt: MESSAGES.genericReprompt, cards: true};

/**
 * A minimal well-formedness check for the SSML this renderer emits: only the known tags, balanced, every `&` an entity
 * reference, no lone surrogate, no `undefined`.
 */
function assertWellFormed(ssml: string): void {
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(ssml),
    false,
    'lone surrogate',
  );
  assert.equal(ssml.includes('undefined'), false, 'undefined rendered');
  assert.equal(/&(?!(amp|lt|gt|quot|apos);)/.test(ssml), false, 'bare ampersand');
  const stack: string[] = [];
  for (const match of ssml.matchAll(/<(\/?)([a-z]+)([^<>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    assert.ok(['speak', 'prosody', 'break', 'audio'].includes(name ?? ''), `unexpected tag ${name}`);
    if (selfClosing) continue;
    if (closing) {
      assert.equal(stack.pop(), name, 'unbalanced tag');
    } else {
      stack.push(name ?? '');
    }
  }
  assert.deepEqual(stack, [], 'unclosed tag');
  assert.equal(ssml.replace(/<[^<>]*>/g, '').includes('<'), false, 'stray <');
}

test('escapeXml escapes the five reserved characters and drops characters XML cannot hold', () => {
  assert.equal(
    escapeXml(`Fix <b> & "quotes" in Tom's form`),
    'Fix &lt;b&gt; &amp; &quot;quotes&quot; in Tom&apos;s form',
  );
  assert.equal(escapeXml('bell\u0007 and\u0000 nul'), 'bell and nul');
  assert.equal(escapeXml('tab\tand\nnewline'), 'tab\tand\nnewline');
  assert.equal(escapeXml('lone \uD800 high, lone \uDC00 low, pair \u{1F600}'), 'lone  high, lone  low, pair \u{1F600}');
});

test('text that looks like SSML is spoken, never interpreted', () => {
  const {ssml} = renderSsml([{text: '<audio src="https://evil.example/x.mp3"/> </speak><speak>'}], {ratePercent: 100});
  assert.equal(ssml.match(/<audio/g), null);
  assert.equal(ssml.match(/<speak>/g)?.length, 1);
  assert.ok(ssml.startsWith('<speak>&lt;audio src=&quot;'));
  assertWellFormed(ssml);
});

test('the security probe inputs: no lone surrogate, no undefined earcon or pause', () => {
  const injected = renderSsml([{text: '</speak><audio src="https://evil/x.mp3"/> & \' " \uD800 lone'}], {
    ratePercent: Number.NaN,
  });
  assertWellFormed(injected.ssml);
  const bogusEarcon = renderSsml([{text: 'x'}], {ratePercent: 100, earcon: 'bogus' as never});
  assert.equal(bogusEarcon.ssml, '<speak>x</speak>');
  const bogusPause = renderSsml([{text: 'a', pauseAfter: 'huge' as never}, {text: 'b'}], {ratePercent: 100});
  assert.equal(bogusPause.ssml, '<speak>a b</speak>');
  const prototypeEarcon = renderSsml([{text: 'x'}], {ratePercent: 100, earcon: 'toString' as never});
  assert.equal(prototypeEarcon.ssml, '<speak>x</speak>');
});

test('segments are joined with breaks for their pauses, and no trailing break', () => {
  const {ssml, cutSegments, cutChars} = renderSsml(
    [
      {text: 'You have 7.', pauseAfter: 'long'},
      {text: 'One: Login   page\n times out.', pauseAfter: 'short'},
      {text: 'Two: Export fails.'},
      {text: '   '},
      {text: 'Say more for the rest.', pauseAfter: 'long'},
    ],
    {ratePercent: 100},
  );
  assert.equal(
    ssml,
    '<speak>You have 7.<break time="900ms"/>One: Login page times out.<break time="350ms"/>' +
      'Two: Export fails. Say more for the rest.</speak>',
  );
  assert.equal(cutSegments, 0);
  assert.equal(cutChars, 0);
});

test('prosody rate is clamped to 20..200 and omitted at 100', () => {
  assert.equal(clampRate(10), 20);
  assert.equal(clampRate(350), 200);
  assert.equal(clampRate(137.6), 138);
  assert.equal(clampRate(Number.NaN), 100);
  assert.equal(renderSsml([{text: 'Hi.'}], {ratePercent: 100}).ssml, '<speak>Hi.</speak>');
  assert.equal(
    renderSsml([{text: 'Hi.'}], {ratePercent: 400}).ssml,
    '<speak><prosody rate="200%">Hi.</prosody></speak>',
  );
});

test('earcons are Sound Library audio: success and failure lead, end-of-list and listening trail', () => {
  assert.equal(
    renderSsml([{text: 'Done.'}], {ratePercent: 150, earcon: 'success'}).ssml,
    `<speak><audio src="${EARCON_SOUNDS.success}"/><prosody rate="150%">Done.</prosody></speak>`,
  );
  assert.equal(
    renderSsml([{text: 'That was the last one.'}], {ratePercent: 100, earcon: 'endOfList'}).ssml,
    `<speak>That was the last one.<audio src="${EARCON_SOUNDS.endOfList}"/></speak>`,
  );
  for (const url of Object.values(EARCON_SOUNDS)) assert.match(url, /^soundbank:\/\/soundlibrary\/[a-z0-9_/]+$/);
});

test('speech over the limit is cut at a word boundary, says so, and is never silent', () => {
  const {ssml, cutSegments, cutChars} = renderSsml([{text: 'x '.repeat(5000)}, {text: 'y'}], {ratePercent: 100});
  assert.ok(ssml.length <= 8000, `ssml length ${ssml.length}`);
  assert.ok(ssml.startsWith('<speak>x x'));
  assert.ok(ssml.endsWith(`${MESSAGES.speechCut}</speak>`));
  assert.equal(cutSegments, 2);
  assert.ok(cutChars > 0);
  assertWellFormed(ssml);

  const small = renderSsml(
    [{text: 'a'.repeat(30)}, {text: 'b'.repeat(30), pauseAfter: 'short'}, {text: 'ccc ccc ccc ccc ccc ccc ccc'}],
    {ratePercent: 100, limit: 110, cutNotice: 'Cut.'},
  );
  assert.ok(small.ssml.length <= 110);
  assert.equal(small.cutSegments, 1);
  assert.match(small.ssml, /^<speak>a{30} b{30}<break time="350ms"\/>(ccc ?)+ Cut\.<\/speak>$/);
});

test("the review's budget probe: a header plus a reserved-character-heavy piece keeps both spoken", () => {
  const header: SpeechSegment = {text: 'Paragraph 2 of 3.', pauseAfter: 'short'};
  const n = 5890;
  const k = Math.round(n * 0.07);
  const piece = `${"' ".repeat(k)}${'a '.repeat((n - 2 * k) / 2)}`.slice(0, n);
  const rendered = renderSsml([header, {text: piece, pauseAfter: 'long'}], {ratePercent: 100});
  assert.ok(rendered.ssml.length <= 8000);
  assert.ok(rendered.ssml.startsWith('<speak>Paragraph 2 of 3.<break time="350ms"/>&apos;'));
  assert.ok(rendered.ssml.endsWith(`${MESSAGES.speechCut}</speak>`));
  assert.equal(rendered.cutSegments, 1);
  assertWellFormed(rendered.ssml);
});

test('code-shaped and JSON-shaped text at the declared budget renders whole', () => {
  const header: SpeechSegment = {text: 'Description, part 1 of 2.', pauseAfter: 'short'};
  const size = MAX_SPEECH_CHARS - 110;
  const shapes = [`if (a < b && c > "d") { x = 'y'; } `, '{"error": "invalid_grant", "status": 400, "ok": false} '];
  for (const shape of shapes) {
    const text = shape.repeat(Math.ceil(size / shape.length)).slice(0, size);
    const rendered = renderSsml([header, {text}], {ratePercent: 175, earcon: 'endOfList'});
    assert.equal(rendered.cutSegments, 0, `${shape.trim()} -> ${rendered.ssml.length}`);
    assertWellFormed(rendered.ssml);
  }
});

test('a cut never splits a surrogate pair or an entity', () => {
  for (let limit = 60; limit < 120; limit += 1) {
    const {ssml} = renderSsml([{text: `${'\u{1F600}&'.repeat(40)}`}], {ratePercent: 100, limit, cutNotice: 'Cut.'});
    assertWellFormed(ssml);
    assert.ok(ssml.length <= limit);
  }
  assert.equal(fittingPrefix('abc def', 3), 'abc');
  assert.equal(fittingPrefix('abcdef', 3), 'abc');
  assert.equal(fittingPrefix('ab.cdef', 4), 'ab.');
  assert.equal(fittingPrefix('a&b', 6), 'a&');
  assert.equal(fittingPrefix('a&b', 5), 'a');
  assert.equal(fittingPrefix('\u{1F600}\u{1F600}', 3), '\u{1F600}');
});

test('a thousand random documents render well-formed and within the limit', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const alphabet = ['a', 'b', ' ', ' ', '&', '<', '>', '"', "'", '\uD800', '\uDC00', '\u{1F600}', '', '.', '\n'];
  for (let doc = 0; doc < 1000; doc += 1) {
    const segments: SpeechSegment[] = [];
    for (let s = 0; s < 1 + Math.floor(random() * 4); s += 1) {
      let text = '';
      for (let c = 0; c < Math.floor(random() * 90); c += 1) text += alphabet[Math.floor(random() * alphabet.length)];
      segments.push({text, pauseAfter: random() < 0.5 ? 'short' : undefined});
    }
    // Above the fixed overhead (speak, prosody, earcon audio and the notice), which no limit could go below.
    const limit = 160 + Math.floor(random() * 300);
    const {ssml} = renderSsml(segments, {
      ratePercent: 50 + random() * 200,
      earcon: 'failure',
      limit,
      cutNotice: 'Cut.',
    });
    assertWellFormed(ssml);
    assert.ok(ssml.length <= limit, `doc ${doc}: ${ssml.length} > ${limit}`);
  }
});

test('listen keeps the session open with the reprompt; not listening ends it without one', () => {
  const listening: VoiceResponse = {
    segments: [{text: 'You have 2.'}],
    listen: true,
    reprompt: [{text: 'Say a number.'}],
    ratePercent: 120,
  };
  const rendered = renderResponse(listening, SPEAKER, NO_CARDS);
  assert.deepEqual(rendered.envelope, {
    version: '1.0',
    response: {
      outputSpeech: {type: 'SSML', ssml: '<speak><prosody rate="120%">You have 2.</prosody></speak>'},
      shouldEndSession: false,
      reprompt: {outputSpeech: {type: 'SSML', ssml: '<speak><prosody rate="120%">Say a number.</prosody></speak>'}},
    },
  });
  assert.equal(rendered.repromptMissing, false);

  const closing = renderResponse({segments: [{text: 'Goodbye.'}], listen: false, ratePercent: 100}, SPEAKER, NO_CARDS);
  assert.deepEqual(closing.envelope.response, {
    outputSpeech: {type: 'SSML', ssml: '<speak>Goodbye.</speak>'},
    shouldEndSession: true,
  });
});

test('a listening response with no reprompt gets the generic one and is flagged', () => {
  const rendered = renderResponse({segments: [{text: 'Hm.'}], listen: true, ratePercent: 100}, SPEAKER, {
    fallbackReprompt: [{text: 'Say help.'}],
    cards: false,
  });
  assert.equal(rendered.repromptMissing, true);
  assert.equal(rendered.envelope.response.reprompt?.outputSpeech.ssml, '<speak>Say help.</speak>');
});

test('a Simple card is sent only with cards on and a screen', () => {
  const voice: VoiceResponse = {
    segments: [{text: 'Issue one.'}],
    listen: false,
    card: {title: 'Issue', text: 'Issue one.'},
    ratePercent: 100,
  };
  assert.equal(renderResponse(voice, SCREEN, NO_CARDS).envelope.response.card, undefined, 'cards off (default)');
  assert.equal(renderResponse(voice, SPEAKER, CARDS).envelope.response.card, undefined, 'no screen');
  assert.deepEqual(renderResponse(voice, SCREEN, CARDS).envelope.response.card, {
    type: 'Simple',
    title: 'Issue',
    content: 'Issue one.',
  });
});

test("card text is cut to Amazon's 8000-character card limit on a whole code point", () => {
  const voice: VoiceResponse = {
    segments: [{text: 'Long.'}],
    listen: false,
    card: {title: 'Issue', text: 'x'.repeat(9000)},
    ratePercent: 100,
  };
  const card = renderResponse(voice, SCREEN, CARDS).envelope.response.card;
  assert.ok(card && card.type === 'Simple');
  assert.equal(card.title.length + card.content.length, 8000);

  const emoji = renderResponse({...voice, card: {title: 'T', text: `${'a'.repeat(7998)}\u{1F600}`}}, SCREEN, CARDS)
    .envelope.response.card;
  assert.ok(emoji && emoji.type === 'Simple');
  assert.equal(emoji.content.length, 7998);
  assert.equal(/[\uD800-\uDBFF]$/.test(emoji.content), false);
});

test('adapter responses: link account card, and the empty response', () => {
  assert.deepEqual(adapterResponse(MESSAGES.linkAccount, {listen: false, linkAccountCard: true}).response.card, {
    type: 'LinkAccount',
  });
  assert.deepEqual(emptyResponse(), {version: '1.0', response: {}});
});
