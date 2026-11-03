#!/usr/bin/env node
/**
 * Writes the generated part of the voice command guide, `docs/voice/commands.md` (YA-32), from the intent catalogue.
 *
 *   node src/voice/docs/generate-commands.ts           rewrites the block between the markers, in place
 *   node src/voice/docs/generate-commands.ts --check   exits 1 if the block is out of date, and changes nothing
 *
 * Only the block between `GENERATED_BEGIN` and `GENERATED_END` is written; everything around it is hand-written. The
 * block lists every phrasing of every intent the voice client has built, with each slot filled in by one spoken
 * example, and every word an enum slot accepts. Each list sits under an `<!-- intent: name -->` tag, the same tag the
 * hand-written sections use, so test/voice/docs/commands.test.ts checks every phrase in the guide the same way: it
 * must parse, through the core grammar, to the intent its section claims.
 */
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {INTENT_CATALOGUE, SLOT_SYNONYMS} from '../core/intents.ts';
import type {IntentName, IntentSpec, SlotSpec} from '../core/types.ts';

export const GENERATED_BEGIN = '<!-- generated: begin -->';
export const GENERATED_END = '<!-- generated: end -->';

/** The stage the deployed voice client has reached. Intents of a later stage belong under "Coming later" only. */
export const BUILT_STAGE = 1;

/**
 * The invocation name the owner chose for the household's skill (YA-10, 2026-09-13). The code does not hold it: it
 * is given to the model generator at deploy time. The guide test checks that the model generator accepts it.
 */
export const GUIDE_INVOCATION_NAME = 'issue desk';

export const COMMANDS_DOC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'voice',
  'commands.md',
);

/** How each built intent is named in the guide. A built intent missing here stops generation. */
export const COMMAND_TITLES: Readonly<Partial<Record<IntentName, string>>> = {
  list: 'Hearing a list of issues',
  find: 'Finding an issue by words from its title',
  open: 'Opening an issue by its number in the list',
  openById: 'Opening an issue by its id',
  read: 'Reading part of the open issue',
  more: 'More',
  previous: 'Previous',
  repeat: 'Repeat',
  where: 'Where am I',
  setVerbosity: 'Detail: brief, normal or full',
  setRate: 'Speed: faster, slower or normal speed',
  help: 'Help',
  cancel: 'Cancel',
  stop: 'Stop',
  airQuality: 'Air quality',
  airQualityPlace: 'Air quality in a place',
  airQualityIndoor: 'Indoor air quality',
};

/**
 * The spoken example put in place of each slot, by slot name, then by slot kind. Chosen to read naturally in most of
 * the catalogue's samples; the test checks that every filled-in phrasing still parses to its intent.
 */
const SLOT_EXAMPLE_BY_NAME: Readonly<Record<string, string>> = {
  person: 'Priya',
  scope: 'open',
  part: 'comments',
  level: 'brief',
  rate: 'slower',
  place: 'Missoula',
};
const SLOT_EXAMPLE_BY_KIND: Readonly<Record<Exclude<SlotSpec['kind'], 'enum'>, string>> = {
  ordinal: 'two',
  spelled: 'hotel twelve',
  phrase: 'boiler',
};

/** The one sample each enum slot's other words are shown in. Must be a sample of the intent that has the slot. */
const SYNONYM_CARRIERS: Readonly<Record<string, string>> = {
  scope: 'list {scope} issues',
  part: 'read the {part}',
  level: '{level} answers',
  rate: '{rate}',
};

/** How an enum value is introduced before its words. */
const VALUE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  scope: {
    mine: 'Your own open issues',
    'in-progress': 'Your issues in progress',
    open: 'All open issues',
    recent: 'The most recently updated',
  },
  part: {summary: 'The title', description: 'The description', comments: 'The comments', fields: 'The fields'},
  level: {brief: 'Brief', normal: 'Normal', full: 'Full'},
  rate: {slower: 'Slower', faster: 'Faster', normal: 'Normal speed'},
};

function slotExample(slot: SlotSpec): string {
  const example = SLOT_EXAMPLE_BY_NAME[slot.name];
  if (example !== undefined) return example;
  if (slot.kind === 'enum') throw new Error(`no spoken example for enum slot "${slot.name}"`);
  return SLOT_EXAMPLE_BY_KIND[slot.kind];
}

function fill(intent: IntentSpec, sample: string, override?: {slot: string; words: string}): string {
  return sample.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    if (override !== undefined && override.slot === name) return override.words;
    const slot = intent.slots.find((candidate) => candidate.name === name);
    if (slot === undefined) throw new Error(`intent ${intent.name}: sample "${sample}" names unknown slot ${name}`);
    return slotExample(slot);
  });
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** Catalogue samples are lower case; the guide writes "I" as people read it. The grammar ignores case. */
function forReading(phrase: string): string {
  return phrase.replace(/(^| )i(?=$| |')/g, '$1I');
}

function quotedList(phrases: readonly string[]): string[] {
  return phrases.map((phrase) => `- "${forReading(phrase)}"`);
}

/** The intents the deployed client has built, in catalogue order. */
export function builtIntents(catalogue: readonly IntentSpec[] = INTENT_CATALOGUE): IntentSpec[] {
  return catalogue.filter((intent) => intent.stage <= BUILT_STAGE);
}

function intentSection(intent: IntentSpec): string[] {
  const title = COMMAND_TITLES[intent.name];
  if (title === undefined) throw new Error(`intent ${intent.name} is built but has no title in COMMAND_TITLES`);
  const lines = [`### ${title}`, '', `<!-- intent: ${intent.name} -->`, ''];
  lines.push(...quotedList(unique(intent.samples.map((sample) => fill(intent, sample)))));

  for (const slot of intent.slots.filter((candidate) => candidate.kind === 'enum')) {
    const carrier = SYNONYM_CARRIERS[slot.name];
    if (carrier === undefined || !intent.samples.includes(carrier)) {
      throw new Error(`intent ${intent.name}: slot "${slot.name}" needs a carrier sample from its own samples`);
    }
    lines.push('', `Other words work in the same places. Here they are in "${fill(intent, carrier)}":`);
    for (const value of slot.values ?? []) {
      const label = VALUE_LABELS[slot.name]?.[value];
      if (label === undefined) throw new Error(`slot "${slot.name}": value "${value}" has no label`);
      const words = SLOT_SYNONYMS[slot.name]?.[value] ?? [];
      if (words.length === 0) continue;
      const phrases = unique(words.map((word) => fill(intent, carrier, {slot: slot.name, words: word})));
      lines.push('', `${label}:`, '', ...quotedList(phrases));
    }
  }
  return lines;
}

/** The whole generated block, markers included, ending without a newline. */
export function renderGeneratedBlock(catalogue: readonly IntentSpec[] = INTENT_CATALOGUE): string {
  const lines = [
    GENERATED_BEGIN,
    '',
    '<!-- Written by src/voice/docs/generate-commands.ts from src/voice/core/intents.ts. Do not edit by hand. -->',
    '',
  ];
  for (const intent of builtIntents(catalogue)) lines.push(...intentSection(intent), '');
  lines.push(GENERATED_END);
  return lines.join('\n');
}

/** The generated block in a document, markers included, or null if the markers are missing or out of order. */
export function extractGeneratedBlock(document: string): string | null {
  const begin = document.indexOf(GENERATED_BEGIN);
  const end = document.indexOf(GENERATED_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  if (document.indexOf(GENERATED_BEGIN, begin + 1) !== -1 || document.indexOf(GENERATED_END, end + 1) !== -1) {
    return null;
  }
  return document.slice(begin, end + GENERATED_END.length);
}

/** The document with its generated block replaced. Throws if the markers are missing, repeated or out of order. */
export function replaceGeneratedBlock(document: string, block: string): string {
  const current = extractGeneratedBlock(document);
  if (current === null) throw new Error(`the guide needs exactly one ${GENERATED_BEGIN} ... ${GENERATED_END} pair`);
  return document.replace(current, () => block);
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unexpected argument: ${unknown[0]}\nusage: generate-commands.ts [--check]\n`);
    return 2;
  }
  const document = readFileSync(COMMANDS_DOC_PATH, 'utf8');
  const updated = replaceGeneratedBlock(document, renderGeneratedBlock());
  const intents = builtIntents().length;
  if (check) {
    const fresh = updated === document;
    process.stderr.write(
      fresh
        ? `commands.md is up to date (${intents} built intents)\n`
        : 'commands.md is out of date: run node src/voice/docs/generate-commands.ts\n',
    );
    return fresh ? 0 : 1;
  }
  if (updated === document) {
    process.stderr.write(`commands.md unchanged (${intents} built intents)\n`);
  } else {
    writeFileSync(COMMANDS_DOC_PATH, updated);
    process.stderr.write(`commands.md: generated block rewritten (${intents} built intents)\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
