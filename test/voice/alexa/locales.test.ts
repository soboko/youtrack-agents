/** Locale artefacts and a semantic regression matrix for YA-37. These tests do not simulate Amazon's NLU. */
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {AIR_LOCALES} from '../../../src/voice/core/air-phrases.ts';
import {catalogueForLocale} from '../../../src/voice/core/intents.ts';
import {compileGrammar, parseUtterance} from '../../../src/voice/core/grammar.ts';
import {buildInteractionModel} from '../../../src/voice/alexa/model.ts';

const CLI = 'src/voice/alexa/generate-model.ts';
const CATALOGUE = 'src/voice/core/intents.ts';
const BASE_ARGS = [CLI, CATALOGUE, '--invocation-name', 'issue desk'];

for (const locale of AIR_LOCALES) {
  test(`${locale}: complete committed model matches the catalogue and retains place slots`, () => {
    const catalogue = catalogueForLocale(locale);
    const model = buildInteractionModel(catalogue, {invocationName: 'issue desk'});
    assert.equal(readFileSync(`models/${locale}/model.json`, 'utf8'), `${JSON.stringify(model, null, 2)}\n`);
    const language = model.interactionModel.languageModel;
    const place = language.intents.find((intent) => intent.name === 'AirQualityPlaceIntent');
    assert.deepEqual(place?.slots, [{name: 'place', type: 'AMAZON.SearchQuery'}]);
    assert.ok(place?.samples?.includes('what the air quality is in {place}'));
    assert.ok(place?.samples?.every((sample) => sample.endsWith('{place}')));
    assert.ok(language.intents.some((intent) => intent.name === 'ListIntent'));
    const grammar = compileGrammar(catalogue);
    const cases = [
      ['what the air quality is in salt lake', 'airQualityPlace', 'salt lake'],
      ['what is the air quality in salt lake city', 'airQualityPlace', 'salt lake city'],
      ['can you tell me what the air quality is near london', 'airQualityPlace', 'london'],
      ['what is the air quality today in toronto', 'airQualityPlace', 'toronto'],
      ['what the air quality index is at park city', 'airQualityPlace', 'park city'],
      ['check the air quality from sensor susans cir', 'airQualityPlace', 'susans cir'],
      ['what the air quality is inside', 'airQualityIndoor', undefined],
      ['what is the air quality in my house', 'airQualityIndoor', undefined],
      ['tell me the air quality from my indoor sensor', 'airQualityIndoor', undefined],
      ['please check the indoor air quality', 'airQualityIndoor', undefined],
      ['what the air quality is outside my house', 'airQuality', undefined],
      ['what is the air quality right now at home', 'airQuality', undefined],
      ['can you check the air quality near me', 'airQuality', undefined],
    ] as const;
    for (const [said, intent, place] of cases) {
      const result = parseUtterance(said, grammar);
      assert.ok(result.matched, said);
      assert.equal(result.intent, intent, said);
      assert.deepEqual(result.slots, place === undefined ? {} : {place}, said);
    }
    const postal = locale === 'en-US' ? 'zip code' : locale === 'en-GB' ? 'postcode' : 'postal code';
    const said = `what the air quality is for ${postal} sw one a one aa`;
    const result = parseUtterance(said, grammar);
    assert.ok(result.matched, said);
    assert.equal(result.intent, 'airQualityPlace');
    assert.deepEqual(result.slots, {place: 'sw one a one aa'});
    const indoor = catalogue.find((intent) => intent.name === 'airQualityIndoor')?.samples ?? [];
    assert.ok(indoor.includes(`air quality in my ${locale === 'en-GB' ? 'flat' : 'apartment'}`));
    assert.ok(!indoor.some((sample) => sample.includes(locale === 'en-GB' ? 'apartment' : 'flat')));
  });
}

test('locale CLI defaults to US, rejects unsupported options, generates all files and detects drift without writing', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ya37-locales-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const run = (...args: string[]) => spawnSync(process.execPath, [...BASE_ARGS, ...args], {encoding: 'utf8'});
  const defaults = run();
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(defaults.stdout, readFileSync('models/en-US/model.json', 'utf8'));
  const british = run('--locale', 'en-GB');
  assert.equal(british.status, 0, british.stderr);
  assert.equal(british.stdout, readFileSync('models/en-GB/model.json', 'utf8'));
  for (const args of [['--locale', 'fr-CA'], ['--locale', 'en-US', '--all-locales'], ['--check'], ['--all-locales']]) {
    const refused = run(...args);
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal(refused.stdout, '');
  }
  const args = ['--all-locales', '--output-dir', directory];
  assert.equal(run(...args).status, 0);
  assert.equal(run(...args, '--check').status, 0);
  const path = join(directory, 'en-GB', 'model.json');
  writeFileSync(path, '{}\n');
  const stale = run(...args, '--check');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /out of date/);
  assert.equal(readFileSync(path, 'utf8'), '{}\n');
});
