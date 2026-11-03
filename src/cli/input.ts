import {readFileSync} from 'node:fs';
import {str} from './args.ts';
import type {OptionValue} from './args.ts';

export type ReadText = (path: string | number) => string;
/** Filesystem/stdin boundary, injectable for CLI tests and embedded consumers. */
export const readText: ReadText = (path) => readFileSync(path, 'utf8');

/** Long options take inline text, a - stdin marker, or a separate --KEY-file path. */
export function longText(
  opts: Record<string, OptionValue>,
  key: string,
  read: ReadText = readText,
): string | undefined {
  const file = str(opts[`${key}-file`]);
  const inline = str(opts[key]);
  if (file !== undefined && inline !== undefined) throw new Error(`choose --${key} or --${key}-file`);
  if (file !== undefined) return read(file);
  return inline === '-' ? read(0) : inline;
}

/** Positional comment/handoff text and --file share identical file-content semantics. */
export function noteText(positional: string[], file: string | undefined, read: ReadText = readText): string {
  if (file !== undefined && positional.length) throw new Error('choose positional text or --file');
  if (file !== undefined) return read(file === '-' ? 0 : file);
  return positional.length === 1 && positional[0] === '-' ? read(0) : positional.join(' ');
}
