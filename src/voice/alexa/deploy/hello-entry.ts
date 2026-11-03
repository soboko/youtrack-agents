/**
 * The hello-world Lambda entry (YA-14, runbook steps 6 and 7). It answers every launch and intent with one fixed
 * sentence, through the same envelope parsing, skill-id check and SSML renderer as the real handler, but with no
 * tracker, no core, no state and no account linking. It proves that a custom skill in the development stage reaches
 * this code from the household's own Echo (unconfirmed on Alexa+, YA-10 Risks), and with ENROLMENT_LOG=true it
 * records the household member's personId for step 6.
 *
 * Every invocation writes at least one JSON line before anything can fail, so "no line in the logs" can only mean
 * Alexa never invoked the function, never that this code rejected the request. The raw event is never logged: it
 * holds three credentials.
 *
 * The full entry (`lambda-entry.ts`) composes createHandler with YA-13's `converse` and YA-15's `trackerFor`, and is
 * written at integration, when both exist.
 */
import {configFromEnvironment, type AlexaSkillConfig} from '../config.ts';
import type {RequestEnvelope, ResponseEnvelope} from '../envelope.ts';
import {errorTypeOf} from '../handler.ts';
import {createJsonLogger, idTag, parseLogLevel} from '../log.ts';
import {applicationIds, InvalidEnvelopeError, parseRequestEnvelope, UnsupportedRequestError} from '../request.ts';
import {adapterResponse, emptyResponse} from '../response.ts';

export const HELLO_SENTENCE =
  'Hello. Your tracker skill is reaching its own code, so custom skills work on this device.';

export interface HelloOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Where log lines go; defaults to stdout, which CloudWatch Logs collects. */
  write?: (line: string) => void;
}

/** Builds the hello handler. Throws, after logging why, if the environment is misconfigured. */
export function createHelloHandler(options: HelloOptions): (event: unknown) => Promise<ResponseEnvelope> {
  const log = createJsonLogger({
    level: parseLogLevel(options.env.LOG_LEVEL, 'info'),
    ...(options.write ? {write: options.write} : {}),
  });

  let config: AlexaSkillConfig;
  try {
    config = configFromEnvironment(options.env);
  } catch (error) {
    // Config errors name variables and kinds, not values.
    log('error', 'alexa.hello.config.invalid', {problem: error instanceof Error ? error.message : 'unknown'});
    throw error;
  }

  const rejectForeignSkill = (ids: readonly string[]): void => {
    if (ids.some((id) => id !== config.skillId)) {
      log('warn', 'alexa.hello.application.rejected', {applicationTags: ids.map(idTag)});
      throw new Error('request is not for this skill');
    }
  };

  return async (event) => {
    const isObject = typeof event === 'object' && event !== null;
    const request = isObject ? (event as {request?: unknown}).request : undefined;
    const requestType =
      typeof request === 'object' && request !== null && typeof (request as {type?: unknown}).type === 'string'
        ? (request as {type: string}).type
        : undefined;
    log('info', 'alexa.hello.invoked', {requestType, topLevelKeys: isObject ? Object.keys(event) : undefined});

    let envelope: RequestEnvelope;
    try {
      envelope = parseRequestEnvelope(event);
    } catch (error) {
      if (error instanceof UnsupportedRequestError) {
        rejectForeignSkill(error.applicationIds);
        return emptyResponse();
      }
      log('warn', 'alexa.hello.envelope.invalid', {
        problem: error instanceof InvalidEnvelopeError ? error.message : 'unknown',
      });
      throw error;
    }
    rejectForeignSkill(applicationIds(envelope));

    const requestId = envelope.request.requestId;
    const personId = envelope.context.System.person?.personId;
    if (config.enrolmentLog && typeof personId === 'string' && personId !== '') {
      log('info', 'alexa.enrolment.person', {requestId, personId});
    }
    if (envelope.request.type === 'SessionEndedRequest') {
      const ended = envelope.request;
      log('info', 'alexa.hello.sessionEnded', {
        requestId,
        reason: ended.reason,
        errorType: errorTypeOf(ended.error?.type),
      });
      log('debug', 'alexa.hello.sessionEnded.detail', {requestId, message: ended.error?.message});
      return emptyResponse();
    }
    log('info', 'alexa.hello.request', {requestType: envelope.request.type, requestId});
    return adapterResponse([{text: HELLO_SENTENCE}], {listen: false, earcon: 'success'});
  };
}

/** The Lambda entry point: `voice/alexa/deploy/hello-entry.handler`. Configured once, at cold start. */
export const handler = createHelloHandler({env: process.env});
