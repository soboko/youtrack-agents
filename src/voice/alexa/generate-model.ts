#!/usr/bin/env node
/**
 * Prints the Alexa interaction model for an intent catalogue (YA-14).
 *
 *   node src/voice/alexa/generate-model.ts <catalogue.ts|catalogue.json> [--invocation-name "my tracker"] > model.json
 *
 * A `.ts`/`.js` catalogue exports `INTENT_CATALOGUE`, optionally with `catalogueForLocale(locale)`; a `.json` one is
 * an array of IntentSpec. The default locale is en-US. Single models go to stdout; --all-locales --output-dir models
 * writes en-US/model.json, en-GB/model.json and en-CA/model.json. --check checks those files without writing.
 * Exits 1 if validation or a file check fails, 2 for invalid arguments. --invocation-name is required.
 */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {IntentSpec} from '../core/types.ts';
import {AIR_LOCALES, type AirLocale} from '../core/air-phrases.ts';
import {buildInteractionModel} from './model.ts';

const USAGE =
  'usage: node src/voice/alexa/generate-model.ts <catalogue.ts|catalogue.json> --invocation-name <name> ' +
  '[--locale en-US|en-GB|en-CA | --all-locales --output-dir <directory> [--check]]';

interface Arguments {
  cataloguePath: string;
  invocationName?: string;
  locale?: AirLocale;
  allLocales?: boolean;
  outputDir?: string;
  check?: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  let cataloguePath: string | undefined;
  let invocationName: string | undefined;
  const options: Omit<Arguments, 'cataloguePath' | 'invocationName'> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--invocation-name') {
      invocationName = argv[index + 1];
      if (invocationName === undefined) throw new Error('--invocation-name needs a value');
      index += 1;
    } else if (argument === '--locale') {
      const value = argv[++index];
      if (!AIR_LOCALES.some((locale) => locale === value)) throw new Error(`unsupported locale: ${value}`);
      options.locale = value as AirLocale;
    } else if (argument === '--all-locales') {
      options.allLocales = true;
    } else if (argument === '--output-dir') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--output-dir needs a directory');
      options.outputDir = value;
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument !== undefined && !argument.startsWith('--') && cataloguePath === undefined) {
      cataloguePath = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }
  if (cataloguePath === undefined) throw new Error('a catalogue path is required');
  if (options.locale && options.allLocales) throw new Error('--locale and --all-locales are mutually exclusive');
  if (Boolean(options.allLocales) !== Boolean(options.outputDir)) {
    throw new Error('--all-locales and --output-dir must be used together');
  }
  if (options.check && !options.allLocales) throw new Error('--check requires --all-locales');
  return {...options, cataloguePath, ...(invocationName === undefined ? {} : {invocationName})};
}

async function loadCatalogue(path: string, locale: AirLocale): Promise<readonly IntentSpec[]> {
  const absolute = resolve(path);
  let loaded: unknown;
  if (absolute.endsWith('.json')) {
    loaded = JSON.parse(await readFile(absolute, 'utf8'));
  } else {
    const module = (await import(pathToFileURL(absolute).href)) as {
      INTENT_CATALOGUE?: unknown;
      catalogueForLocale?: (locale: AirLocale) => unknown;
    };
    loaded =
      typeof module.catalogueForLocale === 'function' ? module.catalogueForLocale(locale) : module.INTENT_CATALOGUE;
  }
  if (!Array.isArray(loaded)) throw new Error(`${path} does not provide an intent catalogue array`);
  // The model's own validation checks every entry's contents; this only establishes it is a list.
  return loaded as readonly IntentSpec[];
}

async function main(): Promise<number> {
  let args: Arguments;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }

  try {
    // Validate every locale before writing any file, so a model error cannot leave a partly regenerated set.
    const outputs = await Promise.all(
      (args.allLocales ? AIR_LOCALES : [args.locale ?? 'en-US']).map(async (locale) => {
        const catalogue = await loadCatalogue(args.cataloguePath, locale);
        const model = buildInteractionModel(catalogue, args);
        return {locale, content: `${JSON.stringify(model, null, 2)}\n`, language: model.interactionModel.languageModel};
      }),
    );
    for (const output of outputs) {
      if (args.outputDir) {
        const directory = resolve(args.outputDir, output.locale);
        const path = resolve(directory, 'model.json');
        if (args.check) {
          if ((await readFile(path, 'utf8')) !== output.content)
            throw new Error(`generated model is out of date: ${path}`);
        } else {
          await mkdir(directory, {recursive: true});
          await writeFile(path, output.content);
        }
      } else {
        process.stdout.write(output.content);
      }
      process.stderr.write(
        `${args.check ? 'checked' : 'generated'} ${output.locale}: ` +
          `${output.language.intents.length} intents, ${output.language.types.length} slot types, ` +
          `invocation name "${output.language.invocationName}"\n`,
      );
    }
    return 0;
  } catch (error) {
    // A ModelRuleError's message lists every broken rule.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = await main();
