import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {canonicalIntent} from '../../../src/voice/alexa/intent-names.ts';
import {
  buildInteractionModel,
  INVOCATION_NAME_PLACEHOLDER,
  ModelRuleError,
  invocationNameProblems,
  validateCatalogue,
  type InteractionModel,
} from '../../../src/voice/alexa/model.ts';
import type {IntentSpec} from '../../../src/voice/core/types.ts';
import {INTENT_CATALOGUE as CORE_CATALOGUE} from '../../../src/voice/core/intents.ts';
import {INTENT_CATALOGUE} from './fixtures/catalogue.ts';

function intentNamed(model: InteractionModel, name: string) {
  const intent = model.interactionModel.languageModel.intents.find((candidate) => candidate.name === name);
  assert.ok(intent, `model has ${name}`);
  return intent;
}

const NAMED = {invocationName: 'my tracker'};

function problemsFor(specs: readonly IntentSpec[]): string[] {
  return validateCatalogue(specs, {invocationName: 'my tracker'});
}

test('the fixture catalogue generates a model', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, {invocationName: 'my tracker'});
  const language = model.interactionModel.languageModel;
  assert.equal(language.invocationName, 'my tracker');
  // 21 catalogue intents plus NavigateHome and Fallback.
  assert.equal(language.intents.length, 23);
  assert.deepEqual(
    language.types.map((type) => type.name),
    ['ScopeValues', 'PartValues', 'LevelValues', 'RateValues', 'StateValues'],
  );
});

test('every intent name in the model maps back to its canonical intent', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, NAMED);
  const names = model.interactionModel.languageModel.intents.map((intent) => intent.name);
  for (const spec of INTENT_CATALOGUE) {
    const alexaName = names.find((name) => canonicalIntent(name) === spec.name);
    assert.ok(alexaName, `${spec.name} is reachable`);
  }
  assert.equal(canonicalIntent('AMAZON.FallbackIntent'), undefined);
  assert.equal(canonicalIntent('AMAZON.MoreIntent'), undefined);
  assert.equal(names.includes('AMAZON.MoreIntent'), false);
});

test('slot kinds: ordinal gets NUMBER plus an Ordinal companion, phrase SearchQuery, spelled AlphaNumeric', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, NAMED);
  const open = intentNamed(model, 'OpenIntent');
  assert.deepEqual(open.slots, [
    {name: 'ordinal', type: 'AMAZON.NUMBER'},
    {name: 'ordinal_ordinal', type: 'AMAZON.Ordinal'},
  ]);
  assert.deepEqual(open.samples, [
    'open {ordinal}',
    'open {ordinal_ordinal}',
    'open number {ordinal}',
    'open number {ordinal_ordinal}',
    'open the {ordinal} one',
    'open the {ordinal_ordinal} one',
  ]);
  assert.deepEqual(intentNamed(model, 'FindIntent').slots, [{name: 'words', type: 'AMAZON.SearchQuery'}]);
  assert.deepEqual(intentNamed(model, 'OpenByIdIntent').slots, [{name: 'spelled', type: 'AMAZON.AlphaNumeric'}]);
});

test('enum slots become custom types whose ids are the catalogue values', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, NAMED);
  assert.deepEqual(intentNamed(model, 'ListIntent').slots, [{name: 'scope', type: 'ScopeValues'}]);
  const scope = model.interactionModel.languageModel.types.find((type) => type.name === 'ScopeValues');
  assert.deepEqual(scope?.values, [
    {id: 'mine', name: {value: 'mine'}},
    {id: 'in-progress', name: {value: 'in progress'}},
    {id: 'open', name: {value: 'open'}},
    {id: 'recent', name: {value: 'recent'}},
  ]);
});

test('same-named enum slots share a type when their values match, and are prefixed when they differ', () => {
  const specs: IntentSpec[] = [
    {
      name: 'list',
      stage: 1,
      slots: [{name: 'state', kind: 'enum', values: ['open', 'fixed']}],
      samples: ['list {state}'],
    },
    {
      name: 'find',
      stage: 1,
      slots: [{name: 'state', kind: 'enum', values: ['open', 'fixed']}],
      samples: ['find {state}'],
    },
    {name: 'setState', stage: 3, slots: [{name: 'state', kind: 'enum', values: ['done']}], samples: ['mark {state}']},
  ];
  const model = buildInteractionModel(specs, NAMED);
  assert.deepEqual(
    model.interactionModel.languageModel.types.map((type) => type.name),
    ['StateValues', 'SetStateStateValues'],
  );
  assert.deepEqual(intentNamed(model, 'SetStateIntent').slots, [{name: 'state', type: 'SetStateStateValues'}]);
});

test('catalogue intents with built-in equivalents extend the built-in; required built-ins are always present', () => {
  const model = buildInteractionModel(INTENT_CATALOGUE, NAMED);
  assert.deepEqual(intentNamed(model, 'AMAZON.NextIntent').samples, ['more', 'carry on']);
  assert.deepEqual(intentNamed(model, 'AMAZON.YesIntent').samples, ['that is right']);
  assert.deepEqual(intentNamed(model, 'AMAZON.StopIntent').samples, []);
  assert.equal(intentNamed(model, 'AMAZON.StopIntent').slots, undefined);
  intentNamed(model, 'AMAZON.FallbackIntent');
  intentNamed(model, 'AMAZON.NavigateHomeIntent');

  const minimal = buildInteractionModel([{name: 'where', stage: 1, slots: [], samples: ['where am i']}], NAMED);
  assert.deepEqual(
    minimal.interactionModel.languageModel.intents.map((intent) => intent.name),
    [
      'WhereIntent',
      'AMAZON.HelpIntent',
      'AMAZON.StopIntent',
      'AMAZON.CancelIntent',
      'AMAZON.NavigateHomeIntent',
      'AMAZON.FallbackIntent',
    ],
  );
});

test('without an invocation name, the placeholder is refused and no model is built', () => {
  assert.throws(
    () => buildInteractionModel(INTENT_CATALOGUE),
    (error: unknown) =>
      error instanceof ModelRuleError && error.problems.some((problem) => problem.includes('placeholder')),
  );
  assert.equal(invocationNameProblems(INVOCATION_NAME_PLACEHOLDER).length, 1);
});

test('phrase rule: a SearchQuery slot cannot share a sample with another slot', () => {
  const problems = problemsFor([
    {
      name: 'comment',
      stage: 3,
      slots: [
        {name: 'ordinal', kind: 'ordinal'},
        {name: 'text', kind: 'phrase'},
      ],
      samples: ['comment on {ordinal} saying {text}', 'comment on {ordinal}'],
    },
  ]);
  assert.deepEqual(problems, [
    'intent comment sample "comment on {ordinal} saying {text}": phrase slot {text} (AMAZON.SearchQuery) cannot share a sample with another slot',
  ]);
});

test('phrase rule: a SearchQuery slot needs carrier words', () => {
  const problems = problemsFor([
    {name: 'dictate', stage: 4, slots: [{name: 'text', kind: 'phrase'}], samples: ['{text}']},
  ]);
  assert.deepEqual(problems, [
    'intent dictate sample "{text}": phrase slot {text} (AMAZON.SearchQuery) needs carrier words around it',
  ]);
});

test('phrase rule: one SearchQuery slot per intent', () => {
  const problems = problemsFor([
    {
      name: 'create',
      stage: 4,
      slots: [
        {name: 'summary', kind: 'phrase'},
        {name: 'description', kind: 'phrase'},
      ],
      samples: ['create {summary}', 'describe it as {description}'],
    },
  ]);
  assert.deepEqual(problems, ['intent create has 2 phrase slots; AMAZON.SearchQuery allows one per intent']);
});

test('generation refuses, listing every problem, when a rule is broken', () => {
  const broken: IntentSpec[] = [
    {name: 'find', stage: 1, slots: [{name: 'words', kind: 'phrase'}], samples: ['{words}']},
    {name: 'open', stage: 1, slots: [{name: 'ordinal', kind: 'ordinal'}], samples: ['open 2', 'open {position}']},
  ];
  assert.throws(
    () => buildInteractionModel(broken, NAMED),
    (error: unknown) =>
      error instanceof ModelRuleError &&
      error.problems.length === 4 &&
      error.problems.some((problem) => problem.includes('needs carrier words')) &&
      error.problems.some((problem) => problem.includes('numbers must be written as words')) &&
      error.problems.some((problem) => problem.includes('undeclared slot {position}')) &&
      error.problems.some((problem) => problem.includes('declares slot {ordinal} but no sample uses it')),
  );
});

test('other catalogue rules', () => {
  const cases: Array<[IntentSpec[], string]> = [
    [
      [
        {
          name: 'help',
          stage: 1,
          slots: [{name: 'topic', kind: 'enum', values: ['lists']}],
          samples: ['help with {topic}'],
        },
      ],
      'cannot take slots',
    ],
    [[{name: 'where', stage: 1, slots: [], samples: []}], 'has no samples'],
    [
      [{name: 'open', stage: 1, slots: [{name: 'the_ordinal', kind: 'ordinal'}], samples: ['open {the_ordinal}']}],
      'letters only',
    ],
    [
      [{name: 'read', stage: 1, slots: [{name: 'part', kind: 'enum', values: []}], samples: ['read {part}']}],
      'enum with no values',
    ],
    [
      [{name: 'read', stage: 1, slots: [{name: 'part', kind: 'enum', values: ['Part 2']}], samples: ['read {part}']}],
      'lower-case words',
    ],
    [
      [{name: 'find', stage: 1, slots: [{name: 'words', kind: 'phrase', values: ['x']}], samples: ['find {words}']}],
      'has values but is a phrase slot',
    ],
    [[{name: 'where', stage: 1, slots: [], samples: ['where am i?']}], 'only letters, spaces'],
    [
      [
        {name: 'where', stage: 1, slots: [], samples: ['where am i']},
        {name: 'repeat', stage: 1, slots: [], samples: ['Where  am I']},
      ],
      'samples must be unique',
    ],
    [
      [
        {name: 'where', stage: 1, slots: [], samples: []},
        {name: 'where', stage: 1, slots: [], samples: ['x']},
      ],
      'appears more than once',
    ],
  ];
  for (const [specs, expected] of cases) {
    const problems = problemsFor(specs);
    assert.ok(
      problems.some((problem) => problem.includes(expected)),
      `expected "${expected}" in ${JSON.stringify(problems)}`,
    );
  }
});

test("invocation name rules follow Amazon's English requirements", () => {
  const refused = [
    'tracker',
    'ask my tracker',
    'open tracker',
    'tracker for chris',
    'computer tracker',
    'my tracker with notes',
    'the tracker',
    'My Tracker',
    'my  tracker',
    'tracker skill',
    'track 2 things',
    INVOCATION_NAME_PLACEHOLDER,
  ];
  for (const name of refused) assert.notDeepEqual(invocationNameProblems(name), [], name);
  for (const name of ['my tracker', 'n. p. r.', "sam's science trivia", 'household tracker notes']) {
    assert.deepEqual(invocationNameProblems(name), [], name);
  }
  const where: IntentSpec[] = [{name: 'where', stage: 1, slots: [], samples: ['where am i']}];
  assert.deepEqual(validateCatalogue(where, {invocationName: "sam's tracker"}), []);
});

test('enum values that are said the same way are refused', () => {
  const problems = problemsFor([
    {
      name: 'list',
      stage: 1,
      slots: [{name: 'scope', kind: 'enum', values: ['in-progress', 'in progress']}],
      samples: ['list {scope}'],
    },
  ]);
  assert.deepEqual(problems, [
    'intent list slot {scope} values "in-progress" and "in progress" are both said "in progress"',
  ]);
});

test('generate-model CLI prints the model to stdout and refuses a broken catalogue with exit 1', (t) => {
  const cli = fileURLToPath(new URL('../../../src/voice/alexa/generate-model.ts', import.meta.url));
  const catalogue = fileURLToPath(new URL('./fixtures/catalogue.ts', import.meta.url));

  const ok = spawnSync(process.execPath, [cli, catalogue, '--invocation-name', 'my tracker'], {encoding: 'utf8'});
  assert.equal(ok.status, 0, ok.stderr);
  const model = JSON.parse(ok.stdout) as InteractionModel;
  assert.equal(model.interactionModel.languageModel.intents.length, 23);
  assert.match(ok.stderr, /generated en-US: 23 intents, 5 slot types/);

  const directory = mkdtempSync(join(tmpdir(), 'ya14-model-'));
  t.after(() => {
    rmSync(directory, {recursive: true, force: true});
  });
  const brokenPath = join(directory, 'broken.json');
  writeFileSync(
    brokenPath,
    JSON.stringify([{name: 'find', stage: 1, slots: [{name: 'words', kind: 'phrase'}], samples: ['{words}']}]),
  );
  const refused = spawnSync(process.execPath, [cli, brokenPath, '--invocation-name', 'my tracker'], {
    encoding: 'utf8',
  });
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /needs carrier words/);

  const unnamed = spawnSync(process.execPath, [cli, catalogue], {encoding: 'utf8'});
  assert.equal(unnamed.status, 1);
  assert.equal(unnamed.stdout, '');
  assert.match(unnamed.stderr, /placeholder/);

  const usage = spawnSync(process.execPath, [cli], {encoding: 'utf8'});
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage:/);
});

test('YA-35: the real catalogue generates, with the person on ListIntent as a SearchQuery and possessives dropped', () => {
  assert.deepEqual(validateCatalogue(CORE_CATALOGUE, NAMED), []);
  const list = intentNamed(buildInteractionModel(CORE_CATALOGUE, NAMED), 'ListIntent');
  assert.deepEqual(list.slots, [
    {name: 'scope', type: 'ScopeValues'},
    {name: 'person', type: 'AMAZON.SearchQuery'},
  ]);
  for (const sample of [
    "what's assigned to {person}",
    '{person} issues',
    'show me {person} issues',
    'issues for {person}',
    'what does {person} have',
  ]) {
    assert.ok(list.samples.includes(sample), sample);
  }
  assert.ok(!list.samples.some((sample) => sample.includes("}'s")), 'a possessive slot reference reached the model');
  // Every sample holding the person holds nothing else, and has carrier words.
  for (const sample of list.samples.filter((candidate) => candidate.includes('{person}'))) {
    assert.doesNotMatch(sample, /\{scope\}/, sample);
    assert.notEqual(sample.replace('{person}', '').trim(), '', sample);
  }
});

test('possessive rule: only a phrase slot may be possessive, and a possessive sample is unique without its "\'s"', () => {
  const enumPossessive = problemsFor([
    {name: 'read', stage: 1, slots: [{name: 'part', kind: 'enum', values: ['summary']}], samples: ["{part}'s text"]},
  ]);
  assert.deepEqual(enumPossessive, [
    'intent read sample "{part}\'s text": only a phrase slot can be possessive, not {part} (enum)',
  ]);
  const twice = problemsFor([
    {name: 'find', stage: 1, slots: [{name: 'words', kind: 'phrase'}], samples: ["{words}'s issues", '{words} issues']},
  ]);
  assert.ok(
    twice.some((problem) => problem.includes('repeats the sample')),
    JSON.stringify(twice),
  );
});
