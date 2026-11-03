import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  parseCardinal,
  parseOrdinal,
  parseRate,
  parseSpelledId,
  resolveEnum,
  spokenId,
} from '../../../src/voice/core/slots.ts';

test('ordinals: words, digits, ordinal words, suffixes, carriers', () => {
  const cases: Array<[string, number | 'last']> = [
    ['two', 2],
    ['2', 2],
    ['second', 2],
    ['2nd', 2],
    ['number 2', 2],
    ['number two', 2],
    ['no 2', 2],
    ['the 2nd one', 2],
    ['the second one', 2],
    ['one', 1],
    ['number one', 1],
    ['first', 1],
    ['the first one', 1],
    ['twelfth', 12],
    ['twenty one', 21],
    ['twenty-one', 21],
    ['twenty first', 21],
    ['21st', 21],
    ['one hundred and five', 105],
    ['last', 'last'],
    ['the last one', 'last'],
  ];
  for (const [said, expected] of cases) assert.equal(parseOrdinal(said), expected, said);
});

test('ordinals refuse anything that is not a position', () => {
  for (const said of [
    '',
    'zero',
    'the',
    'one two',
    'next',
    'banana',
    'first second',
    'twenty twelfth',
    '1000',
    'minus one',
  ]) {
    assert.equal(parseOrdinal(said), null, said);
  }
});

test('cardinals', () => {
  assert.equal(parseCardinal('forty two'), 42);
  assert.equal(parseCardinal('a hundred'), 100);
  assert.equal(parseCardinal('two thousand and six'), 2006);
  assert.equal(parseCardinal('seven bananas'), null);
});

test('spelled ids: the phonetic alphabet, letter names, digits and typed forms', () => {
  const cases: Array<[string, string]> = [
    ['yankee alpha one three', 'YA-13'],
    ['Yankee Alpha 13', 'YA-13'],
    ['y a one three', 'YA-13'],
    ['why ay thirteen', 'YA-13'],
    ['YA-13', 'YA-13'],
    ['ya13', 'YA-13'],
    // AMAZON.AlphaNumeric sends the compact form.
    ['YA14', 'YA-14'],
    ['ya14', 'YA-14'],
    ['ya 13', 'YA-13'],
    ['mike mike dash three five seven', 'MM-357'],
    ['mike mike three fifty seven', 'MM-357'],
    ['mike mike one hundred and two', 'MM-102'],
    ['x ray one', 'X-1'],
    ['xray one oh one', 'X-101'],
    ['oscar papa sierra seven', 'OPS-7'],
    ['double you one', 'W-1'],
    ['tango bravo twenty one', 'TB-21'],
  ];
  for (const [said, expected] of cases) assert.equal(parseSpelledId(said), expected, said);
});

test('spelled ids refuse what is not letters then digits', () => {
  for (const said of [
    '',
    'thirteen',
    'yankee alpha',
    'one yankee',
    'ya 13 b',
    'for thirteen',
    'banana',
    'a b c d e f g h i j k 1',
  ]) {
    assert.equal(parseSpelledId(said), null, said);
  }
});

test('an id the person asked for is spoken letter by letter', () => {
  assert.equal(spokenId('YA-13'), 'Y A 13');
  assert.equal(spokenId('MM-357'), 'M M 357');
});

test('enums resolve canonical values and synonyms only', () => {
  const values = ['mine', 'in-progress', 'open', 'recent'];
  assert.equal(resolveEnum('scope', values, 'in progress'), 'in-progress');
  assert.equal(resolveEnum('scope', values, 'in-progress'), 'in-progress');
  assert.equal(resolveEnum('scope', values, 'Assigned to me'), 'mine');
  assert.equal(resolveEnum('scope', values, 'banana'), null);
});

test('rates: directions and plausible percentages', () => {
  assert.equal(parseRate('faster'), 'faster');
  assert.equal(parseRate('slow down'), 'slower');
  assert.equal(parseRate('normal speed'), 'normal');
  assert.equal(parseRate('150'), 150);
  assert.equal(parseRate('150 percent'), 150);
  assert.equal(parseRate('150%'), 150);
  assert.equal(parseRate('one hundred and twenty five per cent'), 125);
  assert.equal(parseRate('1000 percent'), null);
  assert.equal(parseRate('5'), null);
  assert.equal(parseRate('banana'), null);
});
