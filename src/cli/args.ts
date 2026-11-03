/** A deliberately small option schema: booleans never consume the following positional argument. */
const BOOLEAN_OPTIONS = new Set(['help', 'quiet', 'json', 'debug', 'force', 'no-assign']);
const VALUE_OPTIONS = new Set([
  'model',
  'session',
  'project',
  'url',
  'board',
  'top',
  'summary',
  'description',
  'description-file',
  'recommend',
  'role',
  'type',
  'priority',
  'state',
  'subsystem',
  'assignee',
  'set',
  'check',
  'check-file',
  'assign',
  'file',
  'time',
  'tokens',
  'note',
  'comment',
  'values',
  'empty',
]);
export type OptionValue = string | true | string[];
export interface Args {
  _: string[];
  opts: Record<string, OptionValue>;
}

/** Parse known options once; only --set is repeatable, and malformed options fail before startup. */
export function parseArgs(argv: string[]): Args {
  const result: Args = {_: [], opts: {}};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      result._.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const key = argument.slice(2, equals < 0 ? undefined : equals);
    let value: string | true;
    if (BOOLEAN_OPTIONS.has(key)) {
      if (equals >= 0) throw new Error(`--${key} does not take a value`);
      value = true;
    } else {
      if (!VALUE_OPTIONS.has(key)) throw new Error(`unknown option --${key}`);
      const next = argv[index + 1];
      if (equals >= 0) value = argument.slice(equals + 1);
      else if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index++;
      } else throw new Error(`--${key} needs a value`);
    }
    if (key === 'set' && typeof value === 'string') {
      const previous = result.opts.set;
      result.opts.set = [...(Array.isArray(previous) ? previous : []), value];
    } else {
      if (result.opts[key] !== undefined) throw new Error(`--${key} is not repeatable`);
      result.opts[key] = value;
    }
  }
  return result;
}

/** Read a scalar option without accidentally coercing booleans or repeatable values. */
export function str(value: OptionValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Provider field escape hatch, shared by create --set and the native set command. */
export function pairs(items: string[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const item of items) {
    const equals = item.indexOf('=');
    const name = item.slice(0, equals).trim();
    if (equals <= 0 || !name) throw new Error(`expected Field=Value, got "${item}"`);
    result[name] = item.slice(equals + 1).trim() || null;
  }
  return result;
}
