/**
 * Levelled, structured logging for the Lambda (YA-14). One JSON line per event on stdout, which CloudWatch Logs
 * collects. Content (speech, slot values, raw Amazon ids) is logged at `debug` only, because logs leave the house;
 * the handler follows that rule, and this logger adds a second guard that blanks any field whose name looks like a
 * credential, so a mistake elsewhere cannot print a token.
 */
import {createHash} from 'node:crypto';
import type {LogLevel, VoiceLogger} from '../core/types.ts';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {debug: 10, info: 20, warn: 30, error: 40};

/** Field names never written, at any depth. */
const SECRET_FIELD = /token|secret|authorization|password|credential/i;

export const REDACTED = '[redacted]';

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : fallback;
}

/** Deep copy with credential-named fields blanked. Cycles and depth beyond eight levels are cut. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? REDACTED : redact(field, depth + 1);
  }
  return out;
}

export interface JsonLoggerOptions {
  level: LogLevel;
  /** Where each line goes; defaults to stdout. */
  write?: (line: string) => void;
  now?: () => number;
}

export function createJsonLogger(options: JsonLoggerOptions): VoiceLogger {
  const threshold = LEVEL_ORDER[options.level];
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? Date.now;
  return (level, event, fields) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record = {time: new Date(now()).toISOString(), level, event, ...(redact(fields ?? {}) as object)};
    write(JSON.stringify(record));
  };
}

/**
 * A short, stable, non-reversible tag for an Amazon id, so `info` logs can tell requests from the same speaker apart
 * without carrying the id itself.
 */
export function idTag(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}
