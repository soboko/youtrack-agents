/**
 * The text adapter (YA-13): the voice conversation on a terminal, against a fixture of sample issues, so the
 * household can try the wording before any device or account exists.
 *
 *   node src/voice/text/repl.ts --fixture docs/voice/sample-issues.json [--say] [--evidence person|account|none]
 *     [--state <dir>] [--user <id>] [--max-chars <n>] [--timezone <zone>|none] [--log off|error|warn|info|debug] [--echo]
 *
 * Each line typed is one utterance. Each response segment prints on its own line, with earcons as
 * `[earcon: success]`. With --say, macOS `say` also speaks it, at the rate preference. State is kept in files under
 * --state (default: a folder in the system temp directory), so closing and reopening resumes where you were.
 * Typing "stop" ends the session, as does the end of input.
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {converse, DEFAULT_POLICY, MIN_SUPPORTED_SPEECH_CHARS} from '../core/converse.ts';
import {FakeVoiceTracker, parseTrackerFixture} from '../core/fakes.ts';
import type {
  AdapterCapabilities,
  Earcon,
  LogLevel,
  SpeakerEvidence,
  UserStateStore,
  VoiceInput,
  VoiceResponse,
  VoiceTracker,
} from '../core/types.ts';
import {FileStateStore} from './file-store.ts';
import {renderLines, sayWordsPerMinute} from './render.ts';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const EVIDENCE_CHOICES = ['person', 'account', 'none'] as const;

/** System sounds played for earcons with --say, when present. */
const EARCON_SOUNDS: Readonly<Record<Earcon, string>> = {
  success: '/System/Library/Sounds/Glass.aiff',
  failure: '/System/Library/Sounds/Basso.aiff',
  endOfList: '/System/Library/Sounds/Tink.aiff',
  listening: '/System/Library/Sounds/Pop.aiff',
};

export const DEFAULT_STATE_DIR = join(tmpdir(), 'youtrack-voice-state');
export const DEFAULT_MAX_SPEECH_CHARS = 2000;

export interface ReplOptions {
  tracker: VoiceTracker;
  store: UserStateStore;
  evidence: SpeakerEvidence[];
  userId: string;
  maxSpeechChars: number;
  /** The listener's IANA zone for "today" and "yesterday"; undefined for absolute dates only. */
  timeZone?: string;
  /** Log entries at or above this level go to `errors`, one JSON object per line. */
  logLevel: LogLevel | 'off';
  /** Print each utterance as `> text` before its response; useful when input is piped. */
  echo: boolean;
  input: NodeJS.ReadableStream;
  output: {write(text: string): unknown};
  errors: {write(text: string): unknown};
  now: () => number;
  /** Speaks a response, when --say is on. Resolves once speaking has finished. */
  speak?: (response: VoiceResponse) => Promise<void>;
}

function runProcess(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {stdio: 'ignore'});
    child.on('error', () => {
      resolve();
    });
    child.on('exit', () => {
      resolve();
    });
  });
}

/** Speaks through macOS `say`, playing the earcon's system sound first when there is one. */
export async function speakWithSay(response: VoiceResponse): Promise<void> {
  if (response.earcon !== undefined && existsSync(EARCON_SOUNDS[response.earcon])) {
    await runProcess('afplay', [EARCON_SOUNDS[response.earcon]]);
  }
  const text = response.segments.map((segment) => segment.text).join(' ');
  // "--" ends the options, so no reply can ever be read by `say` as a flag.
  if (text !== '') await runProcess('say', ['-r', String(sayWordsPerMinute(response.ratePercent)), '--', text]);
}

/** Runs a session: launch, one turn per input line, then a session end. Resolves when the session is over. */
export async function runRepl(options: ReplOptions): Promise<void> {
  const capabilities: AdapterCapabilities = {
    ssml: false,
    earcons: true,
    display: false,
    followUp: true,
    maxSpeechChars: options.maxSpeechChars,
  };
  const threshold = options.logLevel === 'off' ? LOG_LEVELS.length : LOG_LEVELS.indexOf(options.logLevel);
  let requests = 0;

  const turn = async (input: VoiceInput): Promise<VoiceResponse> => {
    requests++;
    const response = await converse(
      {
        input,
        speaker: {userId: options.userId, evidence: options.evidence},
        locale: 'en-GB',
        capabilities,
        requestId: `text-${requests}`,
        ...(options.timeZone === undefined ? {} : {timeZone: options.timeZone}),
      },
      {
        tracker: options.tracker,
        store: options.store,
        policy: DEFAULT_POLICY,
        now: options.now,
        log: (level, event, fields) => {
          if (LOG_LEVELS.indexOf(level) >= threshold) {
            options.errors.write(`${JSON.stringify({level, event, ...fields})}\n`);
          }
        },
      },
    );
    for (const line of renderLines(response)) options.output.write(`${line}\n`);
    if (options.speak !== undefined) await options.speak(response);
    return response;
  };

  const first = await turn({kind: 'launch'});
  if (!first.listen) return;

  const lines = createInterface({input: options.input, terminal: false});
  let ended = false;
  for await (const raw of lines) {
    const text = raw.trim();
    if (text === '') continue;
    if (options.echo) options.output.write(`> ${text}\n`);
    const response = await turn({kind: 'utterance', text});
    if (!response.listen) {
      ended = true;
      break;
    }
  }
  lines.close();
  if (!ended) await turn({kind: 'sessionEnded', reason: 'user'});
}

const USAGE = `Usage: node src/voice/text/repl.ts --fixture <issues.json> [--say] [--evidence person|account|none]
  [--state <dir>] [--user <id>] [--max-chars <n>] [--timezone <zone>|none] [--log off|error|warn|info|debug] [--echo]
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        fixture: {type: 'string'},
        say: {type: 'boolean', default: false},
        evidence: {type: 'string', default: 'person'},
        state: {type: 'string', default: DEFAULT_STATE_DIR},
        user: {type: 'string', default: 'text:local'},
        'max-chars': {type: 'string', default: String(DEFAULT_MAX_SPEECH_CHARS)},
        timezone: {type: 'string'},
        log: {type: 'string', default: 'off'},
        echo: {type: 'boolean'},
        help: {type: 'boolean', default: false},
      },
      strict: true,
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const values = parsed.values;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.fixture === undefined) {
    process.stderr.write(`--fixture is required.\n${USAGE}`);
    return 2;
  }
  const evidence = values.evidence;
  if (!EVIDENCE_CHOICES.some((choice) => choice === evidence)) {
    process.stderr.write(`--evidence must be person, account or none.\n${USAGE}`);
    return 2;
  }
  const logLevel = values.log;
  if (logLevel !== 'off' && !LOG_LEVELS.some((level) => level === logLevel)) {
    process.stderr.write(`--log must be off, error, warn, info or debug.\n${USAGE}`);
    return 2;
  }
  const maxSpeechChars = Number(values['max-chars']);
  if (!Number.isInteger(maxSpeechChars) || maxSpeechChars < MIN_SUPPORTED_SPEECH_CHARS) {
    process.stderr.write(`--max-chars must be a whole number of at least ${MIN_SUPPORTED_SPEECH_CHARS}.\n${USAGE}`);
    return 2;
  }

  let tracker: FakeVoiceTracker;
  try {
    tracker = new FakeVoiceTracker(parseTrackerFixture(JSON.parse(readFileSync(values.fixture, 'utf8'))));
  } catch (error) {
    process.stderr.write(
      `Could not load ${values.fixture}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  await runRepl({
    tracker,
    store: new FileStateStore(values.state),
    evidence: [evidence as SpeakerEvidence],
    userId: values.user,
    maxSpeechChars,
    // The computer's own zone unless told otherwise, so "today" means today where the person is.
    timeZone:
      values.timezone === 'none' ? undefined : (values.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    logLevel: logLevel as LogLevel | 'off',
    echo: values.echo ?? !process.stdin.isTTY,
    input: process.stdin,
    output: process.stdout,
    errors: process.stderr,
    now: Date.now,
    speak: values.say ? speakWithSay : undefined,
  });
  return 0;
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main();
}
