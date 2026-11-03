import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  isExactName,
  matchesEveryWord,
  matchPeople,
  nameWords,
  rankBySummary,
  searchWords,
  summaryScore,
} from '../../../src/voice/core/fuzzy.ts';

test('exact, prefix, joined and slightly misspelled words score', () => {
  assert.equal(summaryScore('login', 'Fix the login redirect loop'), 1);
  assert.equal(summaryScore('log in', 'Fix the login redirect loop'), 1);
  assert.equal(summaryScore('log in redirect', 'Fix the login redirect loop'), 1);
  assert.equal(summaryScore('redir', 'Fix the login redirect loop'), 0.8);
  assert.equal(summaryScore('calender', 'Calendar sync drops events'), 0.6);
  assert.equal(summaryScore('kangaroo', 'Fix the login redirect loop'), 0);
});

test('only true fillers are dropped from a search', () => {
  assert.deepEqual(searchWords('the one about the login issue'), ['login']);
  assert.deepEqual(searchWords('well pump'), ['well', 'pump']);
  assert.deepEqual(searchWords('right sidebar for now'), ['right', 'sidebar', 'for', 'now']);
});

test('accents fold and any script counts', () => {
  assert.equal(summaryScore('zoe', 'Réparer la chaudière pour Zoë'), 1);
  assert.equal(summaryScore('chaudiere', 'Réparer la chaudière pour Zoë'), 1);
  assert.equal(summaryScore('日本語', 'Translate the 日本語 manual'), 1);
});

test('a single match is only "every word" when every meaningful word was found', () => {
  assert.equal(matchesEveryWord('calendar', 'Calendar sync drops events'), true);
  assert.equal(matchesEveryWord('log in redirect', 'Fix the login redirect loop'), true);
  // Near misses that must not open an issue on their own.
  assert.equal(matchesEveryWord('dark matter', 'Add dark mode to settings'), false);
  assert.equal(matchesEveryWord('loop hole', 'Fix the login redirect loop'), false);
  assert.equal(matchesEveryWord('the', 'The thing'), false);
});

test('ranking keeps every item, best first, tracker order among equals', () => {
  const items = ['Login page copy', 'Fix the login redirect loop', 'Dark mode'];
  assert.deepEqual(
    rankBySummary('login redirect', items, (item) => item),
    ['Fix the login redirect loop', 'Login page copy', 'Dark mode'],
  );
});

const PEOPLE = [
  {login: 'cholloway', name: 'Chris Holloway'},
  {login: 'ccoulter', name: 'Chris Coulter'},
  {login: 'zoe7', name: 'Zoë Ångström'},
  {login: 'household1', name: 'The Household'},
  {login: 'christine.b', name: 'Christine Blake'},
  {login: 'mary_anne', name: 'Mary Anne Price'},
];

function matched(spoken: string): string[] {
  return matchPeople(spoken, PEOPLE).people.map((person) => person.name);
}

test('YA-35: a spoken name loses case, accents, possessives, titles and fillers', () => {
  assert.deepEqual(nameWords("Chris's"), ['chris']);
  assert.deepEqual(nameWords("James' "), ['james']);
  assert.deepEqual(nameWords('the Household'), ['household']);
  assert.deepEqual(nameWords('Mrs Zoë Ångström please'), ['zoe', 'angstrom']);
});

test('YA-35: people match by full name, first name, surname or login, exact before prefix before near', () => {
  assert.deepEqual(matched('chris coulter'), ['Chris Coulter']);
  assert.deepEqual(matched('CHRIS COULTER'), ['Chris Coulter']);
  assert.deepEqual(matched("holloway's"), ['Chris Holloway']);
  assert.deepEqual(matched('ccoulter'), ['Chris Coulter']);
  assert.deepEqual(matched('christine b'), ['Christine Blake']);
  assert.deepEqual(matched('mary anne'), ['Mary Anne Price']);
  assert.deepEqual(matched('maryanne'), ['Mary Anne Price']);
  // Accents fold both ways, and a near miss is found when nothing closer is.
  assert.deepEqual(matched('zoe angstrom'), ['Zoë Ångström']);
  assert.deepEqual(matched('Zoë'), ['Zoë Ångström']);
  assert.equal(matchPeople('zoey', PEOPLE).tier, 'near');
  assert.deepEqual(matched('zoey'), ['Zoë Ångström']);
  assert.deepEqual(matched('chris hollowey'), ['Chris Holloway']);
  // "The household" is a name like any other.
  assert.deepEqual(matched('the household'), ['The Household']);
});

test('YA-35: a shared first name is every match at the best tier, in name order; "Chris" is not also "Christine"', () => {
  const chris = matchPeople('chris', PEOPLE);
  assert.equal(chris.tier, 'exact');
  assert.deepEqual(
    chris.people.map((person) => person.login),
    ['ccoulter', 'cholloway'],
  );
  assert.deepEqual(matched('chri'), ['Chris Coulter', 'Chris Holloway', 'Christine Blake']);
});

test('YA-35: nobody matches a name with a word nobody has, or no name at all', () => {
  assert.deepEqual(matched('sam'), []);
  assert.deepEqual(matched('chris smith'), []);
  assert.deepEqual(matchPeople('the', PEOPLE), {people: [], tier: null});
  assert.deepEqual(matchPeople('chris', []), {people: [], tier: null});
});

test('YA-35 F4: only a whole full name, a first name or a login is exact; a surname, prefix or near miss is not', () => {
  const mary = {login: 'mary_jones2', name: 'Mary Jones'};
  for (const said of ['mary jones', 'Mary', "mary's", 'mary jones2', 'maryjones2', 'the Mary Jones']) {
    assert.equal(isExactName(said, mary), true, said);
  }
  for (const said of ['jones', 'mar', 'mark', 'mary j', '']) assert.equal(isExactName(said, mary), false, said);
});
