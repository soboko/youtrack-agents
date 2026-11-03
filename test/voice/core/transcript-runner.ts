/**
 * Runs a conversation transcript against the voice core with the fake tracker, a memory store and a fake clock.
 *
 * Format, one item per line:
 *   # comment
 *   > utterance                 a turn, as the text adapter would send it
 *   < expected line             the response, rendered as the text adapter prints it (earcon line first)
 *   < ...                       after at least one expected line: stop checking this turn's remaining lines
 *   < (silence)                 the response has no speech
 *   @launch                     a launch turn;  @end user|silence|error  a session-ended turn
 *   @intent name slot=value     an adapter-resolved intent (values may be "quoted")
 *   @confidence 0.2             recogniser confidence for the next utterance
 *   @fixture name               test/voice/core/fixtures/<name>.json, or `sample` for docs/voice/sample-issues.json
 *   @generate 60                add that many open issues assigned to the fixture's "me"
 *   @evidence person account    the speaker's evidence (`none` for none)
 *   @policy person,account      the kinds `readAccepts` lists
 *   @ttl 12h  @advance 13h      working-set lifetime; move the clock (ms, s, m, h, d)
 *   @at 2026-09-12T03:00:00Z    set the clock
 *   @timezone Europe/London     the listener's zone (`none`, the default, for absolute dates only)
 *   @maxchars 400  @display on  @user alice  @cap 3  @cap-comments 1  @cap-people 2  @latency 900
 *   @fail getIssue unavailable [times]  @update YA-21 summary=New words  @remove YA-21  @corrupt-state [text]
 *   @load-state name            store test/voice/core/fixtures/states/<name>.json for the current user
 *   @assert listen false  @assert rate 125  @assert calls getIssue 2  @assert calls-this-turn getIssue 0
 *   @assert reprompt Say 'more' to go on.  @assert card Your issues  @assert log warn voice.state.loaded
 *   @assert unspoken ccoulter    no response so far, speech or reprompt, contains that text (any case)
 *
 * Air quality (YA-36), with the real service over fake PurpleAir sensors and a fake geocoder
 * (test/voice/core/fixtures/air.json; sensor ages count back from the transcript's start):
 *   @air off                    no air-quality service at all (`on`, the default, puts it back)
 *   @device 59802 US            the device's postal code and country;  @device none  (the default)
 *   @home 46.87,-113.99         the home setting, a point or a place name;  @home none  (the default). Rebuilds the
 *                               service, so its cache starts empty
 *   @air-fail purpleair unavailable [times]  @air-fail geocoder [times]
 *   @assert air-calls purpleair 2  @assert air-calls-this-turn geocoder 0
 *
 * Fixture, generate and tracker settings must come in that order: a fixture replaces the tracker, so a cap or failure
 * set before it would be lost, and the runner refuses that. A malformed directive throws, naming its line.
 *
 * Every response is also checked against invariants that hold for any conversation (see `responseInvariantFailures`),
 * and every log entry above `debug` against every piece of content the conversation touched.
 */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AIR_HERE_WORDS, converse, DEFAULT_POLICY} from '../../../src/voice/core/converse.ts';
import {
  createFakeClock,
  FakeVoiceTracker,
  MemoryStateStore,
  parseTrackerFixture,
} from '../../../src/voice/core/fakes.ts';
import type {FakeTrackerMethod, IssueFixture, TrackerFixture} from '../../../src/voice/core/fakes.ts';
import {parseUtterance} from '../../../src/voice/core/grammar.ts';
import {FakeGeocoder, FakePurpleAir, parseAirFixture} from '../../../src/voice/air/fakes.ts';
import type {PurpleAirFailureKind} from '../../../src/voice/air/purpleair.ts';
import {createAirQualityService, parseHomeLocation} from '../../../src/voice/air/service.ts';
import {INTENT_CATALOGUE} from '../../../src/voice/core/intents.ts';
import type {
  AdapterCapabilities,
  AirQualityPort,
  DeviceLocation,
  IntentName,
  LogLevel,
  SpeakerEvidence,
  VoiceInput,
  VoicePolicy,
  VoiceResponse,
} from '../../../src/voice/core/types.ts';
import {resolveEnum} from '../../../src/voice/core/slots.ts';
import {LIST_SCOPES} from '../../../src/voice/core/state.ts';
import {renderLines} from '../../../src/voice/text/render.ts';
import type {TrackerFailureKind} from '../../../src/tracker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, 'fixtures');
export const TRANSCRIPTS_DIR = join(HERE, 'transcripts');
export const SAMPLE_FIXTURE = join(HERE, '..', '..', '..', 'docs', 'voice', 'sample-issues.json');

/** 2026-09-12 09:00 UTC, a Saturday. */
export const TRANSCRIPT_START = Date.parse('2026-09-12T09:00:00Z');

const EVIDENCE_KINDS: readonly SpeakerEvidence[] = ['person', 'account', 'caller-id', 'keypad-pin', 'none'];
const FAILURE_KINDS: readonly TrackerFailureKind[] = [
  'validation',
  'not-found',
  'permission',
  'conflict',
  'unsupported',
  'unavailable',
  'unknown',
];
const TRACKER_METHODS: readonly FakeTrackerMethod[] = ['listIssues', 'getIssue', 'listComments', 'listAssignees'];
const END_REASONS = ['user', 'silence', 'error'] as const;
const UPDATABLE_FIELDS = ['summary', 'description', 'state', 'assignee', 'subsystem', 'updated'] as const;
/** Slots whose values are what the person said about the tracker's content, not a choice from a list. */
const CONTENT_SLOTS = new Set(['words', 'spelled', 'text', 'state', 'summary', 'person', 'place']);
const PURPLEAIR_FAILURES: readonly PurpleAirFailureKind[] = [
  'no-key',
  'key-refused',
  'points',
  'rate-limited',
  'unavailable',
  'malformed',
];
const NEEDLE_WINDOW = 16;
const NEEDLE_STEP = 8;

/** Patterns that must never appear in speech or reprompts, whatever a transcript expects. */
export const FORBIDDEN_IN_SPEECH: readonly RegExp[] = [
  /`/,
  /\|/,
  /\*\*/,
  /~~/,
  /!\[/,
  /\]\(/,
  /<\/?[a-z][a-z0-9]*\s*\/?>/i,
  /&[a-z]+;/i,
  /:\/\//,
  /\bwww\./i,
  /(^|\s)#+\s/,
  /\b[A-Z][A-Z0-9]{0,9}-\d+\b(?![-\w])/,
  /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{10,}/,
  /\bgithub_pat_|\bglpat-|\bxox[abpr]-/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[\w-]{8,}\.[\w-]+/,
  /\bperm:[\w.=-]{8,}/,
  /\b[A-Fa-f0-9]{24,}\b/,
  /check the app/i,
  // YA-36: nothing shaped like a coordinate ("46.8721", "-113.99") is ever spoken.
  /-?\b\d{1,3}\.\d{2,}\b/,
];

export interface TranscriptTurnResult {
  line: number;
  input: string;
  lines: string[];
}

export interface TranscriptResult {
  failures: string[];
  turns: TranscriptTurnResult[];
}

interface CapturedLog {
  level: LogLevel;
  event: string;
  fields: Readonly<Record<string, unknown>> | undefined;
}

interface PendingTurn {
  line: number;
  input: string;
  lines: string[];
  expected: string[];
  wildcard: boolean;
}

/** Invariants every response must satisfy, whatever was asked. Returns a message per broken invariant. */
export function responseInvariantFailures(
  response: VoiceResponse,
  maxSpeechChars: number,
  sessionEnded: boolean,
): string[] {
  const failures: string[] = [];
  const chars = response.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  if (chars > maxSpeechChars) failures.push(`speech is ${chars} chars, over ${maxSpeechChars}`);
  const repromptChars = (response.reprompt ?? []).reduce((sum, segment) => sum + segment.text.length, 0);
  if (repromptChars > maxSpeechChars) failures.push(`reprompt is ${repromptChars} chars, over ${maxSpeechChars}`);
  for (const segment of [...response.segments, ...(response.reprompt ?? [])]) {
    for (const pattern of FORBIDDEN_IN_SPEECH) {
      if (pattern.test(segment.text)) failures.push(`speech matches forbidden ${pattern}: "${segment.text}"`);
    }
  }
  if (response.listen && (response.reprompt === undefined || response.reprompt.length === 0)) {
    failures.push('listening with no reprompt');
  }
  if (sessionEnded && response.segments.length > 0) failures.push('speech after the session ended');
  return failures;
}

function directiveError(name: string, line: number, message: string): Error {
  return new Error(`${name}:${line}: ${message}`);
}

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text.trim());
  if (!match) throw new Error(`Not a duration: "${text}"`);
  const units: Record<string, number> = {ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000};
  return Number(match[1]) * units[match[2]];
}

/** A whole, non-negative number, or an error: "150x" must never quietly become NaN. */
export function parseCount(text: string | undefined): number {
  if (text === undefined || !/^\d+$/.test(text.trim())) throw new Error(`Not a whole number: "${text ?? ''}"`);
  return Number(text);
}

function parseAssignments(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /(\w+)=("([^"]*)"|\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) result[match[1]] = match[3] ?? match[2];
  return result;
}

function evidenceList(text: string): SpeakerEvidence[] {
  return text
    .split(/[\s,]+/)
    .filter((kind) => kind !== '')
    .map((kind) => {
      if (!EVIDENCE_KINDS.includes(kind as SpeakerEvidence)) throw new Error(`Unknown evidence kind "${kind}"`);
      return kind as SpeakerEvidence;
    });
}

export function loadFixture(name: string): TrackerFixture {
  const path = name === 'sample' ? SAMPLE_FIXTURE : join(FIXTURES_DIR, `${name}.json`);
  return parseTrackerFixture(JSON.parse(readFileSync(path, 'utf8')));
}

function generated(fixture: TrackerFixture, count: number): TrackerFixture {
  const issues: IssueFixture[] = [...fixture.issues];
  for (let i = 1; i <= count; i++) {
    issues.push({
      key: `GEN-${i}`,
      summary: `Generated task ${i}`,
      state: 'Open',
      assignee: fixture.me,
      updated: Date.parse('2026-01-01T00:00:00Z') - i * 60_000,
    });
  }
  return {...fixture, issues};
}

function windows(text: string): string[] {
  if (text.length < NEEDLE_WINDOW) return [];
  const found: string[] = [];
  for (let start = 0; start + NEEDLE_WINDOW <= text.length; start += NEEDLE_STEP) {
    found.push(text.slice(start, start + NEEDLE_WINDOW));
  }
  found.push(text.slice(-NEEDLE_WINDOW));
  return found;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Runs one transcript and reports every mismatch with its line number. Throws on a malformed transcript. */
export async function runTranscript(source: string, name = 'transcript'): Promise<TranscriptResult> {
  const failures: string[] = [];
  const turns: TranscriptTurnResult[] = [];
  const clock = createFakeClock(TRANSCRIPT_START);
  const store = new MemoryStateStore();
  const logs: CapturedLog[] = [];
  const policy: VoicePolicy = {...DEFAULT_POLICY};
  const capabilities: AdapterCapabilities = {
    ssml: false,
    earcons: true,
    display: false,
    followUp: true,
    maxSpeechChars: 1000,
  };
  let fixture = loadFixture('team');
  let tracker = new FakeVoiceTracker(fixture, {clock});
  let trackerConfigured = false;
  let evidence: SpeakerEvidence[] = ['person'];
  let userId = 'test:person:sam';
  let timeZone: string | undefined;
  let confidence: number | undefined;
  let requestCount = 0;
  let started = false;
  const airFixture = parseAirFixture(JSON.parse(readFileSync(join(FIXTURES_DIR, 'air.json'), 'utf8')));
  const purpleAir = new FakePurpleAir(airFixture.sensors, TRANSCRIPT_START, clock.now);
  const geocoder = new FakeGeocoder(airFixture.places);
  let airOn = true;
  let deviceLocation: DeviceLocation | undefined;
  const buildAir = (home: string | undefined): AirQualityPort =>
    createAirQualityService({
      purpleAir,
      geocoder,
      ...(parseHomeLocation(home).home === undefined ? {} : {home: parseHomeLocation(home).home}),
      now: clock.now,
      log: (level, event, fields) => {
        logs.push({level, event, fields});
      },
    });
  let airQuality = buildAir(undefined);
  let homeSetting: string | undefined;

  // Content the conversation touched, for the log invariant.
  const exactNeedles = new Set<string>();
  const wordNeedles = new Set<string>();
  const addFixtureNeedles = (issues: readonly IssueFixture[], people: Readonly<Record<string, string>>): void => {
    for (const [login, fullName] of Object.entries(people)) {
      if (login.length >= 3) wordNeedles.add(login);
      if (fullName.length >= 3) wordNeedles.add(fullName);
    }
    for (const issue of issues) {
      exactNeedles.add(issue.summary);
      wordNeedles.add(issue.key);
      if (issue.assignee !== null && issue.assignee !== undefined && issue.assignee.length >= 3) {
        wordNeedles.add(issue.assignee);
      }
      for (const paragraph of (issue.description ?? '').split(/\n\s*\n/)) {
        for (const piece of windows(paragraph.trim())) exactNeedles.add(piece);
      }
      for (const comment of issue.comments ?? []) {
        for (const piece of windows(comment.text)) exactNeedles.add(piece);
        if (comment.author.length >= 3) wordNeedles.add(comment.author);
      }
    }
  };

  const responses: VoiceResponse[] = [];
  const cursor: {
    last: {response: VoiceResponse; logsFrom: number; callsFrom: number} | null;
    pending: PendingTurn | null;
  } = {last: null, pending: null};

  const fail = (line: number, message: string): void => {
    failures.push(`${name}:${line}: ${message}`);
  };

  const closePending = (): void => {
    if (cursor.pending === null) return;
    const {line, input, lines, expected, wildcard} = cursor.pending;
    const silenceExpected = expected.length === 1 && expected[0] === '(silence)';
    if (expected.length === 0) {
      fail(line, `turn "${input}" has no expected lines; got:\n  < ${lines.join('\n  < ')}`);
    } else if (silenceExpected) {
      if (lines.length > 0) fail(line, `expected silence for "${input}", got:\n  < ${lines.join('\n  < ')}`);
    } else {
      const compared = wildcard ? lines.slice(0, expected.length) : lines;
      if (compared.length !== expected.length || compared.some((text, index) => text !== expected[index])) {
        fail(
          line,
          `"${input}"\n  expected:\n  < ${expected.join('\n  < ')}${wildcard ? '\n  < ...' : ''}\n  actual:\n  < ${lines.join('\n  < ')}`,
        );
      }
    }
    cursor.pending = null;
  };

  let airCallsFrom = {purpleair: 0, geocoder: 0};

  const runTurn = async (line: number, label: string, input: VoiceInput): Promise<void> => {
    closePending();
    started = true;
    requestCount++;
    const logsFrom = logs.length;
    const callsFrom = tracker.calls.length;
    airCallsFrom = {purpleair: purpleAir.calls.length, geocoder: geocoder.calls.length};
    const response = await converse(
      {
        input,
        speaker: {userId, evidence},
        locale: 'en-GB',
        capabilities: {...capabilities},
        requestId: `req-${requestCount}`,
        ...(timeZone === undefined ? {} : {timeZone}),
        ...(deviceLocation === undefined ? {} : {deviceLocation}),
      },
      {
        tracker,
        store,
        policy,
        now: clock.now,
        log: (level, event, fields) => {
          logs.push({level, event, fields});
        },
        ...(airOn ? {airQuality} : {}),
      },
    );
    const lines = renderLines(response);
    responses.push(response);
    turns.push({line, input: label, lines});
    cursor.last = {response, logsFrom, callsFrom};
    cursor.pending = {line, input: label, lines, expected: [], wildcard: false};
    for (const message of responseInvariantFailures(
      response,
      capabilities.maxSpeechChars,
      input.kind === 'sessionEnded',
    )) {
      fail(line, message);
    }
    for (const segment of response.segments) {
      for (const piece of windows(segment.text)) exactNeedles.add(piece);
    }
  };

  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const text = lines[index].trim();
    if (text === '' || text.startsWith('#')) continue;

    if (text.startsWith('<')) {
      const expected = text === '<' ? '' : text.slice(text.startsWith('< ') ? 2 : 1);
      if (cursor.pending === null) {
        throw directiveError(name, lineNumber, 'expected line with no turn before it');
      } else if (expected === '...') {
        if (cursor.pending.expected.length === 0) {
          throw directiveError(name, lineNumber, '"< ..." needs at least one expected line before it');
        }
        cursor.pending.wildcard = true;
      } else {
        cursor.pending.expected.push(expected);
      }
      continue;
    }
    if (text.startsWith('>')) {
      const utterance = text.slice(1).trim();
      // What was said never reaches a log above debug: not when it was misheard, and not when it was set aside for
      // low confidence. (A phrasing that matched is logged as its catalogue sample, which is not content.)
      if (utterance.length >= 8 && (confidence !== undefined || !parseUtterance(utterance).matched)) {
        exactNeedles.add(utterance);
      }
      const input: VoiceInput =
        confidence === undefined
          ? {kind: 'utterance', text: utterance}
          : {kind: 'utterance', text: utterance, confidence};
      confidence = undefined;
      await runTurn(lineNumber, utterance, input);
      continue;
    }
    if (!text.startsWith('@')) throw directiveError(name, lineNumber, `unrecognised line: ${text}`);

    const [directive, ...rest] = text.slice(1).split(/\s+/);
    const argument = text.slice(1 + directive.length).trim();
    try {
      switch (directive) {
        case 'launch':
          await runTurn(lineNumber, '@launch', {kind: 'launch'});
          continue;
        case 'end': {
          const reason = rest[0] ?? 'user';
          if (!END_REASONS.some((known) => known === reason)) throw new Error(`Unknown end reason "${reason}"`);
          await runTurn(lineNumber, `@end ${reason}`, {kind: 'sessionEnded', reason: reason as 'user'});
          continue;
        }
        case 'intent': {
          const intent = rest[0];
          if (!INTENT_CATALOGUE.some((spec) => spec.name === intent)) throw new Error(`Unknown intent "${intent}"`);
          const slots = parseAssignments(argument.slice(intent.length));
          await runTurn(lineNumber, `@intent ${argument}`, {kind: 'intent', intent: intent as IntentName, slots});
          continue;
        }
        default:
          break;
      }
      closePending();
      switch (directive) {
        case 'confidence': {
          const value = Number(argument);
          if (argument === '' || !Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error(`Confidence must be between 0 and 1, not "${argument}"`);
          }
          confidence = value;
          break;
        }
        case 'fixture':
        case 'generate':
          if (started) throw new Error(`@${directive} must come before the first turn`);
          if (trackerConfigured) throw new Error(`@${directive} would discard tracker settings made before it`);
          fixture = directive === 'fixture' ? loadFixture(argument) : generated(fixture, parseCount(argument));
          tracker = new FakeVoiceTracker(fixture, {clock});
          break;
        case 'evidence': {
          const kinds = evidenceList(argument).filter((kind) => kind !== 'none');
          evidence = kinds.length === 0 ? ['none'] : kinds;
          break;
        }
        case 'policy':
          policy.readAccepts = evidenceList(argument);
          break;
        case 'ttl':
          policy.workingSetTtlMs = parseDuration(argument);
          break;
        case 'advance':
          clock.advance(parseDuration(argument));
          break;
        case 'at': {
          const time = Date.parse(argument);
          if (!/^\d{4}-\d{2}-\d{2}T/.test(argument) || !Number.isFinite(time)) {
            throw new Error(`@at takes an ISO 8601 time, not "${argument}"`);
          }
          clock.set(time);
          break;
        }
        case 'timezone':
          if (argument === '') throw new Error('@timezone needs a zone, or "none"');
          timeZone = argument === 'none' ? undefined : argument;
          break;
        case 'maxchars':
          capabilities.maxSpeechChars = parseCount(argument);
          break;
        case 'display':
          if (argument !== 'on' && argument !== 'off') throw new Error(`@display takes on or off, not "${argument}"`);
          capabilities.display = argument === 'on';
          break;
        case 'user':
          if (argument === '') throw new Error('@user needs an id');
          userId = argument;
          break;
        case 'cap':
          tracker.listCap = parseCount(argument);
          trackerConfigured = true;
          break;
        case 'cap-comments':
          tracker.commentCap = parseCount(argument);
          trackerConfigured = true;
          break;
        case 'cap-people':
          tracker.peopleCap = parseCount(argument);
          trackerConfigured = true;
          break;
        case 'latency':
          tracker.latencyMs = parseCount(argument);
          trackerConfigured = true;
          break;
        case 'fail': {
          const [method, kind, times] = rest;
          if (!TRACKER_METHODS.some((known) => known === method)) throw new Error(`Unknown tracker method "${method}"`);
          if (!FAILURE_KINDS.some((known) => known === kind)) throw new Error(`Unknown failure kind "${kind}"`);
          tracker.failNext(
            method as FakeTrackerMethod,
            kind as TrackerFailureKind,
            times === undefined ? 1 : parseCount(times),
          );
          trackerConfigured = true;
          break;
        }
        case 'update': {
          const match = /^(\S+)\s+(\w+)=(.*)$/.exec(argument);
          if (!match) throw new Error('@update takes KEY field=value');
          const [, key, field, raw] = match;
          if (!UPDATABLE_FIELDS.some((known) => known === field)) throw new Error(`Cannot update field "${field}"`);
          const value = raw === 'null' ? null : raw.replace(/\\n/g, '\n');
          tracker.update(key, {[field]: value});
          if (value !== null && field !== 'updated') {
            for (const piece of [value, ...windows(value)]) if (piece.length >= 8) exactNeedles.add(piece);
          }
          break;
        }
        case 'remove':
          if (argument === '') throw new Error('@remove needs a key');
          tracker.remove(argument);
          break;
        case 'air':
          if (argument !== 'on' && argument !== 'off') throw new Error(`@air takes on or off, not "${argument}"`);
          airOn = argument === 'on';
          break;
        case 'device': {
          if (argument === 'none') {
            deviceLocation = undefined;
            break;
          }
          const [postalCode, countryCode] = rest;
          if (postalCode === undefined || countryCode === undefined || rest.length !== 2) {
            throw new Error('@device takes a postal code and a country code, or none');
          }
          deviceLocation = {postalCode, countryCode};
          wordNeedles.add(postalCode);
          break;
        }
        case 'home':
          if (argument === '') throw new Error('@home needs a location, or none');
          homeSetting = argument === 'none' ? undefined : argument;
          airQuality = buildAir(homeSetting);
          if (homeSetting !== undefined) wordNeedles.add(homeSetting);
          break;
        case 'air-fail': {
          const [target, kind, times] = rest;
          if (target === 'geocoder') {
            geocoder.failNext(kind === undefined ? 1 : parseCount(kind));
          } else if (target === 'purpleair') {
            if (!PURPLEAIR_FAILURES.some((known) => known === kind))
              throw new Error(`Unknown PurpleAir failure "${kind}"`);
            purpleAir.failNext(kind as PurpleAirFailureKind, times === undefined ? 1 : parseCount(times));
          } else {
            throw new Error(`@air-fail takes purpleair or geocoder, not "${target}"`);
          }
          break;
        }
        case 'load-state':
          if (argument === '') throw new Error('@load-state needs a state fixture name');
          store.put(userId, readFileSync(join(FIXTURES_DIR, 'states', `${argument}.json`), 'utf8'));
          break;
        case 'corrupt-state':
          store.put(userId, argument === '' ? '{"version": 99}' : argument);
          break;
        case 'assert': {
          if (cursor.last === null) throw new Error('@assert with no turn before it');
          const {response, logsFrom, callsFrom} = cursor.last;
          const [what, ...values] = rest;
          const value = values.join(' ');
          switch (what) {
            case 'listen':
              if (String(response.listen) !== value)
                fail(lineNumber, `listen is ${response.listen}, expected ${value}`);
              break;
            case 'rate':
              if (String(response.ratePercent) !== value) {
                fail(lineNumber, `ratePercent is ${response.ratePercent}, expected ${value}`);
              }
              break;
            case 'calls':
            case 'calls-this-turn': {
              const from = what === 'calls' ? 0 : callsFrom;
              const until = what === 'calls' ? tracker.calls.length : tracker.calls.length;
              const count = tracker.calls.slice(from, until).filter((call) => call.method === values[0]).length;
              if (count !== parseCount(values[1]))
                fail(lineNumber, `${what} ${values[0]} is ${count}, expected ${values[1]}`);
              break;
            }
            case 'air-calls':
            case 'air-calls-this-turn': {
              const target = values[0];
              if (target !== 'purpleair' && target !== 'geocoder') throw new Error(`Unknown air service "${target}"`);
              const total = target === 'purpleair' ? purpleAir.calls.length : geocoder.calls.length;
              const count = what === 'air-calls' ? total : total - airCallsFrom[target];
              if (count !== parseCount(values[1]))
                fail(lineNumber, `${what} ${target} is ${count}, expected ${values[1]}`);
              break;
            }
            case 'reprompt': {
              const reprompt = (response.reprompt ?? []).map((segment) => segment.text).join(' ');
              if (reprompt !== value) fail(lineNumber, `reprompt is "${reprompt}", expected "${value}"`);
              break;
            }
            case 'unspoken': {
              if (value === '') throw new Error('@assert unspoken needs some text');
              const wanted = value.toLowerCase();
              for (const said of responses) {
                for (const segment of [...said.segments, ...(said.reprompt ?? [])]) {
                  if (segment.text.toLowerCase().includes(wanted)) {
                    fail(lineNumber, `"${value}" was spoken: "${segment.text}"`);
                  }
                }
              }
              break;
            }
            case 'card': {
              const title = response.card?.title ?? '(none)';
              if (title !== value) fail(lineNumber, `card title is "${title}", expected "${value}"`);
              break;
            }
            case 'log':
            case 'no-log': {
              const found = logs
                .slice(logsFrom)
                .some((entry) => entry.level === values[0] && entry.event === values[1]);
              if (what === 'log' && !found) fail(lineNumber, `no ${values[0]} log ${values[1]} in the turn before`);
              if (what === 'no-log' && found) fail(lineNumber, `unexpected ${values[0]} log ${values[1]}`);
              break;
            }
            default:
              throw new Error(`Unknown assertion "${what}"`);
          }
          break;
        }
        default:
          throw new Error(`Unknown directive @${directive}`);
      }
      // Tracker calls made by the turns so far stay on this tracker even if a later directive rebuilds it.
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${name}:`)) throw error;
      throw directiveError(name, lineNumber, error instanceof Error ? error.message : String(error));
    }
  }
  closePending();

  // Logs above debug never carry tracker content, ids, names, slot values, utterances or speech.
  addFixtureNeedles(fixture.issues, fixture.people ?? {});
  // Nor sensor names, place words, postal codes or coordinates (YA-36).
  for (const sensor of airFixture.sensors) {
    wordNeedles.add(sensor.name);
    for (const value of [sensor.lat, sensor.lon]) wordNeedles.add(String(value));
  }
  for (const [place, point] of Object.entries(airFixture.places)) {
    if (place.length >= 3) wordNeedles.add(place);
    for (const value of point ?? []) wordNeedles.add(String(value));
  }
  for (const entry of logs) {
    if (entry.level !== 'debug' || entry.event !== 'voice.intent.slots') continue;
    const slots = (entry.fields?.slots ?? {}) as Record<string, unknown>;
    for (const [slot, value] of Object.entries(slots)) {
      // A person said as a list scope ("issues for mine") is logged as that scope, which is not content.
      const isScope =
        slot === 'person' && typeof value === 'string' && resolveEnum('scope', LIST_SCOPES, value) !== null;
      // "Air quality at home" names no place: "home" is the setting, and the logs may say it was used.
      const isHere = slot === 'place' && typeof value === 'string' && AIR_HERE_WORDS.has(value);
      if (CONTENT_SLOTS.has(slot) && typeof value === 'string' && value.length >= 3 && !isScope && !isHere) {
        wordNeedles.add(value);
      }
    }
  }
  const wordPatterns = [...wordNeedles].map((needle) => new RegExp(`(^|[^\\w])${escapeRegExp(needle)}($|[^\\w])`, 'i'));
  for (const entry of logs) {
    if (entry.level === 'debug') continue;
    const serialized = JSON.stringify(entry.fields ?? {});
    for (const needle of exactNeedles) {
      if (needle.length >= 8 && serialized.includes(needle)) {
        failures.push(`${name}: ${entry.level} log ${entry.event} contains content: "${needle}"`);
      }
    }
    wordPatterns.forEach((pattern, index) => {
      if (pattern.test(serialized)) {
        failures.push(`${name}: ${entry.level} log ${entry.event} contains "${[...wordNeedles][index]}"`);
      }
    });
  }
  return {failures, turns};
}
