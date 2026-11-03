import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileGrammar, FILLERS_ANYWHERE, normaliseUtterance, parseUtterance} from '../../../src/voice/core/grammar.ts';
import {FILLER_KEY_TOKENS} from '../../../src/voice/core/slots.ts';
import {INTENT_CATALOGUE, SLOT_SYNONYMS} from '../../../src/voice/core/intents.ts';
import type {IntentName, SlotSpec} from '../../../src/voice/core/types.ts';

// A compile-time list of every intent: adding one to the contract without cataloguing it fails this file's types.
const ALL_INTENTS: Record<IntentName, true> = {
  list: true,
  find: true,
  open: true,
  openById: true,
  read: true,
  more: true,
  previous: true,
  repeat: true,
  where: true,
  help: true,
  setVerbosity: true,
  setRate: true,
  cancel: true,
  stop: true,
  airQuality: true,
  airQualityPlace: true,
  airQualityIndoor: true,
  comment: true,
  setState: true,
  confirm: true,
  deny: true,
  create: true,
  dictate: true,
  finishDictation: true,
};

function exampleFor(slot: SlotSpec): {said: string; value: string} {
  switch (slot.kind) {
    case 'ordinal':
      return {said: 'two', value: '2'};
    case 'spelled':
      return {said: 'yankee alpha one three', value: 'YA-13'};
    case 'phrase':
      return {said: 'garden gate', value: 'garden gate'};
    case 'enum': {
      // The canonical value itself, spoken: a synonym such as "my" would rightly match a more specific literal sample.
      const value = slot.values?.[0] ?? '';
      return {said: value.replace(/-/g, ' '), value};
    }
    default:
      return {said: '', value: ''};
  }
}

test('the catalogue covers every intent exactly once', () => {
  const names = INTENT_CATALOGUE.map((spec) => spec.name);
  assert.deepEqual([...names].sort(), Object.keys(ALL_INTENTS).sort());
  assert.equal(new Set(names).size, names.length);
});

test('samples are Alexa-safe: lower case, no digits, no punctuation but apostrophes and acronym periods, known slots', () => {
  for (const spec of INTENT_CATALOGUE) {
    assert.ok(spec.samples.length > 0, `${spec.name} has no samples`);
    const slotNames = new Set(spec.slots.map((slot) => slot.name));
    for (const sample of spec.samples) {
      // An acronym is its letters, each with a period ("a. q. i."), as Amazon writes them; no other period.
      assert.match(sample.replace(/(^| )[a-z]\.(?= |$)/g, '$1x'), /^[a-z' {}]+$/, `${spec.name}: "${sample}"`);
      for (const [, name] of sample.matchAll(/\{(\w+)\}/g)) {
        assert.ok(slotNames.has(name), `${spec.name}: "${sample}" uses undeclared slot ${name}`);
      }
    }
  }
});

test('slot names are letters only and enum values lower case, as the Alexa model generator requires', () => {
  for (const spec of INTENT_CATALOGUE) {
    for (const slot of spec.slots) {
      assert.match(slot.name, /^[A-Za-z]+$/, `${spec.name}.${slot.name}`);
      for (const value of slot.values ?? []) assert.equal(value, value.toLowerCase(), `${spec.name}.${slot.name}`);
    }
  }
  const rate = INTENT_CATALOGUE.find((spec) => spec.name === 'setRate')?.slots[0];
  assert.deepEqual(rate?.values, ['slower', 'faster', 'normal']);
});

test('a sample with a phrase slot holds carrier words and that one slot only', () => {
  for (const spec of INTENT_CATALOGUE) {
    const phraseSlots = new Set(spec.slots.filter((slot) => slot.kind === 'phrase').map((slot) => slot.name));
    for (const sample of spec.samples) {
      const used = [...sample.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      if (!used.some((name) => phraseSlots.has(name))) continue;
      assert.equal(used.length, 1, `${spec.name}: "${sample}" mixes a phrase slot with another slot`);
      assert.notEqual(sample.replace(/\{\w+\}/g, '').trim(), '', `${spec.name}: "${sample}" has no carrier words`);
    }
  }
});

test('no sample is repeated within an intent or shared between intents', () => {
  const seen = new Map<string, string>();
  for (const spec of INTENT_CATALOGUE) {
    assert.equal(new Set(spec.samples).size, spec.samples.length, `${spec.name} repeats an exact sample`);
    for (const sample of spec.samples) {
      const key = normaliseUtterance(sample);
      // Alexa training deliberately includes full questions, contractions and polite forms. The text grammar
      // normalises these to the same wording; only overlap between different intents is ambiguous.
      assert.ok(
        !seen.has(key) || seen.get(key) === spec.name,
        `"${sample}" appears under ${seen.get(key)} and ${spec.name}`,
      );
      seen.set(key, spec.name);
    }
  }
});

test('every sample, with its slots filled, parses back to its own intent and slot values', () => {
  for (const spec of INTENT_CATALOGUE) {
    for (const sample of spec.samples) {
      const expected: Record<string, string> = {};
      const utterance = sample.replace(/\{(\w+)\}/g, (_match, name: string) => {
        const slot = spec.slots.find((candidate) => candidate.name === name);
        assert.ok(slot);
        const example = exampleFor(slot);
        expected[name] = example.value;
        return example.said;
      });
      const parsed = parseUtterance(utterance);
      assert.ok(parsed.matched, `"${utterance}" (from ${spec.name}: "${sample}") did not parse`);
      assert.equal(parsed.intent, spec.name, `"${utterance}" parsed as ${parsed.intent}, sample of ${spec.name}`);
      assert.deepEqual(parsed.slots, expected, `"${utterance}"`);
    }
  }
});

test('every enum synonym resolves to its canonical value, and the grammar accepts only listed synonyms', () => {
  const carriers: Record<string, string> = {
    scope: 'show {} issues',
    part: 'read the {}',
    level: '{} mode',
    rate: 'talk {}',
  };
  for (const [slotName, values] of Object.entries(SLOT_SYNONYMS)) {
    for (const [value, synonyms] of Object.entries(values)) {
      for (const synonym of synonyms) {
        const utterance = carriers[slotName].replace('{}', synonym);
        const parsed = parseUtterance(utterance);
        assert.ok(parsed.matched, `"${utterance}" did not parse`);
        assert.equal(parsed.slots[slotName], value, `"${utterance}"`);
      }
    }
  }
  // Said alone, "normal" is the verbosity; the speed is "normal speed".
  assert.deepEqual(parseUtterance('normal'), {
    matched: true,
    intent: 'setVerbosity',
    slots: {level: 'normal'},
    sample: '{level}',
    score: 4,
  });
  const speed = parseUtterance('normal speed');
  assert.ok(speed.matched && speed.intent === 'setRate' && speed.slots.rate === 'normal');
  assert.equal(parseUtterance('talk normal').matched, false);
});

test('every hesitation sound can be a project key: before a number it is kept, and the id opens', () => {
  for (const filler of FILLER_KEY_TOKENS) {
    const key = filler.toUpperCase();
    for (const utterance of [
      `open issue ${filler}-12`,
      `open issue ${key} 12`,
      `${filler}-12`,
      `go to issue ${key}-12`,
    ]) {
      const parsed = parseUtterance(utterance);
      assert.ok(parsed.matched, `"${utterance}" did not parse`);
      assert.equal(parsed.intent, 'openById', utterance);
      assert.equal(parsed.slots.spelled, `${key}-12`, utterance);
      // Only without a carrier word, and only for hesitation-shaped keys, is the position kept as a fallback.
      const fallback = !utterance.includes('issue') && FILLER_KEY_TOKENS.has(filler) ? '12' : undefined;
      assert.equal(parsed.slots.fallbackOrdinal, fallback, utterance);
    }
  }
  const spoken: Array<[string, string]> = [
    ['open issue mm twelve', 'MM-12'],
    ['issue em em one two', 'MM-12'],
    ['open issue er 3', 'ER-3'],
    ['hm-4', 'HM-4'],
    ['er 3', 'ER-3'],
    ['open mm twelve', 'MM-12'],
    ['open issue mike mike one two', 'MM-12'],
  ];
  for (const [utterance, id] of spoken) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched && parsed.intent === 'openById', utterance);
    assert.equal(parsed.slots.spelled, id, utterance);
  }
  assert.deepEqual(parseUtterance('open um two'), {
    matched: true,
    intent: 'openById',
    slots: {spelled: 'UM-2', fallbackOrdinal: '2'},
    sample: 'open {spelled}',
    score: 12,
  });
  const noFallback = parseUtterance('open ya 99');
  assert.ok(noFallback.matched && noFallback.slots.fallbackOrdinal === undefined);
  // Away from a number, hesitation is still just hesitation.
  for (const utterance of ['um, open two', 'open, um, number two', 'uh the second one please']) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched && parsed.intent === 'open', utterance);
    assert.deepEqual(parsed.slots, {ordinal: '2'}, utterance);
  }
});

test('a hesitation while spelling an id is a pause, and politeness is never part of an id', () => {
  const cases: Array<[string, IntentName, Record<string, string>]> = [
    ['open issue um yankee alpha one three', 'openById', {spelled: 'YA-13'}],
    ['open issue uh Y A 13', 'openById', {spelled: 'YA-13'}],
    ['issue yankee alpha um one three', 'openById', {spelled: 'YA-13'}],
    ['open issue, er, hotel oscar mike echo 12', 'openById', {spelled: 'HOME-12'}],
    ['open please two', 'open', {ordinal: '2'}],
    ['read please 2', 'open', {ordinal: '2'}],
    ['please 3', 'open', {ordinal: '3'}],
    ['number um two', 'open', {ordinal: '2'}],
    ['open number um two', 'open', {ordinal: '2'}],
    ['open can you two', 'open', {ordinal: '2'}],
    ['can you open two now', 'open', {ordinal: '2'}],
    ['what can you do', 'help', {}],
  ];
  for (const [utterance, intent, slots] of cases) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, `"${utterance}" did not parse`);
    assert.equal(parsed.intent, intent, utterance);
    assert.deepEqual(parsed.slots, slots, utterance);
  }
  for (const filler of FILLERS_ANYWHERE) {
    if (FILLER_KEY_TOKENS.has(filler)) continue;
    const parsed = parseUtterance(`open ${filler} two`);
    assert.ok(parsed.matched && parsed.intent === 'open', `"${filler}" became part of an id`);
  }
});

test('"issue 12" is an id with its letters missing, never position 12', () => {
  for (const utterance of ['issue 12', 'open issue 12', 'go to issue twelve']) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, utterance);
    assert.equal(parsed.intent, 'openById', utterance);
    assert.deepEqual(parsed.slots, {}, utterance);
  }
});

test('typed ids need no carrier word in the text grammar, but words and numbers alone are not ids', () => {
  for (const [utterance, id] of [
    ['YA-13', 'YA-13'],
    ['open ya13', 'YA-13'],
    ['go to YA 13', 'YA-13'],
    ['yankee alpha one three', 'YA-13'],
  ]) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched && parsed.intent === 'openById', utterance);
    assert.deepEqual(parsed.slots, {spelled: id}, utterance);
  }
  for (const utterance of ['try two', 'open banana', 'open -1', 'page two']) {
    const parsed = parseUtterance(utterance);
    assert.ok(!parsed.matched || parsed.intent !== 'openById', `"${utterance}" became an id`);
  }
  const two = parseUtterance('two');
  assert.ok(two.matched && two.intent === 'open');
});

test('search words keep what was said: no filler stripping inside a phrase, accents folded', () => {
  for (const [utterance, words] of [
    ['find well pump', 'well pump'],
    ['find right sidebar', 'right sidebar'],
    ['find now playing', 'now playing'],
    ['find so and so', 'so and so'],
    ['find cards for me', 'cards for me'],
    ['find Zoë', 'zoe'],
    ['find 日本語', '日本語'],
  ]) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched && parsed.intent === 'find', utterance);
    assert.equal(parsed.slots.words, words, utterance);
  }
});

test('YA-35: a person is heard in a phrase slot, and a possessive sample needs its "\'s"', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["what's assigned to Chris Coulter", {person: 'chris coulter'}],
    ["Chris's issues", {person: 'chris'}],
    ["show me the household's issues", {person: 'the household'}],
    ['issues for Zoë', {person: 'zoe'}],
    ['what does chris have', {person: 'chris'}],
    ['what is Priya working on', {person: 'priya'}],
    ['issues assigned to sam please', {person: 'sam'}],
  ];
  for (const [utterance, slots] of cases) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, utterance);
    assert.equal(parsed.intent, 'list', utterance);
    assert.deepEqual(parsed.slots, slots, utterance);
  }
  // The scope phrasings still win where they apply, and a bare "... issues" is nobody's.
  for (const [utterance, slots] of [
    ['open issues', {scope: 'open'}],
    ["what's assigned to me", {}],
  ] as const) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, utterance);
    assert.deepEqual(parsed.slots, slots, utterance);
  }
  assert.equal(parseUtterance('banana issues').matched, false);
  assert.throws(
    () =>
      compileGrammar([
        {name: 'read', stage: 1, slots: [{name: 'part', kind: 'enum', values: ['x']}], samples: ["{part}'s"]},
      ]),
    /only a phrase slot can be possessive/,
  );
});

test("destructive, bulk and other-people's-work phrasings are not in the catalogue (rule 9)", () => {
  for (const spec of INTENT_CATALOGUE) {
    for (const sample of spec.samples) {
      assert.doesNotMatch(
        sample,
        /\b(delete|remove|erase|close all|assign|reassign|bulk|everything|all issues)\b/,
        sample,
      );
    }
  }
  for (const utterance of ['delete issue one', 'close all my issues', 'assign it to ana', 'remove all comments']) {
    assert.equal(parseUtterance(utterance).matched, false, utterance);
  }
});

test('fillers and politeness are ignored', () => {
  const cases: Array<[string, IntentName, Record<string, string>]> = [
    ['um, open two please', 'open', {ordinal: '2'}],
    ['Can you read the description?', 'read', {part: 'description'}],
    ["I'd like to list my issues, thanks", 'list', {}],
    ['okay so uh where am I', 'where', {}],
    ['could you please go back', 'previous', {}],
    ['Well, just tell me more now.', 'more', {}],
    ['What is number three', 'open', {ordinal: '3'}],
  ];
  for (const [utterance, intent, slots] of cases) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, `"${utterance}" did not parse`);
    assert.equal(parsed.intent, intent, utterance);
    assert.deepEqual(parsed.slots, slots, utterance);
  }
});

test('ordinals, spelled ids and typed ids in context', () => {
  const cases: Array<[string, IntentName, Record<string, string>]> = [
    ['the 2nd one', 'open', {ordinal: '2'}],
    ['open the second one', 'open', {ordinal: '2'}],
    ['number 2', 'open', {ordinal: '2'}],
    ['go to twenty first', 'open', {ordinal: '21'}],
    ['open the last one', 'open', {ordinal: 'last'}],
    ['open issue yankee alpha one three', 'openById', {spelled: 'YA-13'}],
    ['open issue YA-13', 'openById', {spelled: 'YA-13'}],
    ['issue y a thirteen', 'openById', {spelled: 'YA-13'}],
    ['find issue mike mike three five seven', 'openById', {spelled: 'MM-357'}],
    ['set speed to 150%', 'setRate', {rate: '150'}],
    ['set speed to one hundred and fifty percent', 'setRate', {rate: '150'}],
  ];
  for (const [utterance, intent, slots] of cases) {
    const parsed = parseUtterance(utterance);
    assert.ok(parsed.matched, `"${utterance}" did not parse`);
    assert.equal(parsed.intent, intent, utterance);
    assert.deepEqual(parsed.slots, slots, utterance);
  }
});

test('an id carrier with no readable id matches with the id absent, so the core can say how to spell one', () => {
  const parsed = parseUtterance('open issue banana');
  assert.ok(parsed.matched);
  assert.equal(parsed.intent, 'openById');
  assert.deepEqual(parsed.slots, {});
});

test('anything else is a miss, never a guess', () => {
  for (const utterance of [
    '',
    '   ',
    'okay',
    'blah blah',
    'what is the weather tomorrow',
    'open',
    'open banana',
    'open -1',
    'set speed to fast-ish',
  ]) {
    const parsed = parseUtterance(utterance);
    assert.equal(parsed.matched, false, `"${utterance}" matched ${parsed.matched ? parsed.intent : ''}`);
  }
});
