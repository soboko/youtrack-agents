/**
 * The subset of the Alexa Skills Kit request and response JSON this adapter reads and writes (YA-14). Hand-written
 * instead of depending on `ask-sdk`, per the YA-10 packet. Field names were checked against Amazon's references on
 * 2026-09-12; the URLs are in docs/voice/alexa.md under "Sources".
 *
 * Request: https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html
 * Types:   https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-types-reference.html
 *
 * Everything on the request side is optional unless Amazon documents it as always present, because the envelope is
 * external input and is validated at runtime by `parseRequestEnvelope` in request.ts.
 */

// ---------------------------------------------------------------------------------------------------------------
// Request.

export interface AlexaApplication {
  applicationId: string;
}

export interface AlexaUser {
  userId: string;
  /** Present when the Amazon account has linked the skill (account-level linking). A credential: never logged. */
  accessToken?: string;
}

/** Present only when Alexa recognised the speaker and they turned on "Personalize skills". Not authentication. */
export interface AlexaPerson {
  /** Different for each skill, and for each Amazon account on the same device. */
  personId: string;
  /** Present when this recognised person linked their own account (person-level linking). Never logged. */
  accessToken?: string;
  /** 300 for voice alone, 400 and up with a verification step. Typed only: not used as evidence. */
  authenticationConfidenceLevel?: {level: number};
}

export interface AlexaSession {
  new: boolean;
  sessionId: string;
  application: AlexaApplication;
  user: AlexaUser;
  attributes?: Record<string, unknown>;
}

export interface AlexaDevice {
  /** Addresses the Device Settings API (time zone). An Amazon id: logged at debug only. */
  deviceId?: string;
  /** A map keyed by interface name, e.g. `{"AudioPlayer": {}}`. Not an array. */
  supportedInterfaces?: Record<string, unknown>;
}

export interface AlexaSystem {
  application: AlexaApplication;
  user: AlexaUser;
  person?: AlexaPerson;
  device?: AlexaDevice;
  /** Regional base URL for Alexa APIs, e.g. `https://api.amazonalexa.com`. */
  apiEndpoint?: string;
  /** Bearer token for Alexa APIs such as the Progressive Response API. A credential: never logged. */
  apiAccessToken?: string;
}

export interface AlexaContext {
  System: AlexaSystem;
  /** Present when the device has a screen. */
  Viewport?: Record<string, unknown>;
}

export interface LaunchRequest {
  type: 'LaunchRequest';
  requestId: string;
  timestamp: string;
  locale: string;
}

export type ErStatusCode = 'ER_SUCCESS_MATCH' | 'ER_SUCCESS_NO_MATCH' | 'ER_ERROR_TIMEOUT' | 'ER_ERROR_EXCEPTION';

export interface ResolutionValue {
  value: {name: string; id?: string};
}

export interface ResolutionPerAuthority {
  authority: string;
  status: {code: ErStatusCode};
  values?: ResolutionValue[];
}

export interface AlexaSlot {
  name: string;
  /** Absent when the slot was not filled. AMAZON.NUMBER sends `?` for a value it could not parse. */
  value?: string;
  confirmationStatus?: 'NONE' | 'CONFIRMED' | 'DENIED';
  resolutions?: {resolutionsPerAuthority: ResolutionPerAuthority[]};
}

export interface AlexaIntent {
  name: string;
  confirmationStatus?: 'NONE' | 'CONFIRMED' | 'DENIED';
  slots?: Record<string, AlexaSlot>;
}

export interface IntentRequest {
  type: 'IntentRequest';
  requestId: string;
  timestamp: string;
  locale: string;
  dialogState?: 'STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  intent: AlexaIntent;
}

export interface SessionEndedRequest {
  type: 'SessionEndedRequest';
  requestId: string;
  timestamp: string;
  locale?: string;
  reason: 'USER_INITIATED' | 'ERROR' | 'EXCEEDED_MAX_REPROMPTS';
  error?: {type: string; message: string};
}

export type AlexaRequest = LaunchRequest | IntentRequest | SessionEndedRequest;

export interface RequestEnvelope {
  version: string;
  /** Absent for some out-of-session requests (AudioPlayer); always present for the three types handled here. */
  session?: AlexaSession;
  context: AlexaContext;
  request: AlexaRequest;
}

// ---------------------------------------------------------------------------------------------------------------
// Response.

export interface SsmlOutputSpeech {
  type: 'SSML';
  ssml: string;
}

export interface SimpleCard {
  type: 'Simple';
  title: string;
  content: string;
}

/** Shown in the Alexa app; opens the account-linking flow. Takes no other fields. */
export interface LinkAccountCard {
  type: 'LinkAccount';
}

/**
 * Shown in the Alexa app; asks the customer to grant the listed permissions (YA-36: the device's country and postal
 * code). https://developer.amazon.com/en-US/docs/alexa/custom-skills/use-device-address.html
 */
export interface AskForPermissionsConsentCard {
  type: 'AskForPermissionsConsent';
  permissions: string[];
}

export interface AlexaResponseBody {
  outputSpeech?: SsmlOutputSpeech;
  card?: SimpleCard | LinkAccountCard | AskForPermissionsConsentCard;
  reprompt?: {outputSpeech: SsmlOutputSpeech};
  shouldEndSession?: boolean;
}

export interface ResponseEnvelope {
  version: '1.0';
  /** Echoed back by Alexa in `session.attributes` on the next request of the same session. */
  sessionAttributes?: Record<string, unknown>;
  response: AlexaResponseBody;
}

// ---------------------------------------------------------------------------------------------------------------
// Progressive Response API (POST {apiEndpoint}/v1/directives).
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html

export interface ProgressiveResponseBody {
  header: {requestId: string};
  directive: {type: 'VoicePlayer.Speak'; speech: string};
}
