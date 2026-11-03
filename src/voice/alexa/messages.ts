/**
 * The only sentences the Alexa adapter says on its own: the moments the conversation core cannot be reached (no
 * linked account, an unrecognised voice, a turn that runs out of time, a failure) and speech cut at the platform
 * limit. Everything else is the core's wording. Kept in one place, in the core's rigid style, so they can be changed
 * after the household's first trial without touching logic.
 * None of them names the tracker's contents, a token or an error's text.
 */
import type {SpeechSegment} from '../core/types.ts';

export const MESSAGES = {
  linkAccount: [
    {text: 'Your tracker account is not linked yet.', pauseAfter: 'short'},
    {text: 'I have sent a link card to the Alexa app. Open it there to link your account. You only do this once.'},
  ],
  relinkAccount: [
    {text: 'Your tracker account link has expired or was removed.', pauseAfter: 'short'},
    {text: 'I have sent a link card to the Alexa app, so you can link it again.'},
  ],
  progressive: 'One moment.',
  tooSlow: [{text: 'The tracker is taking too long to answer.', pauseAfter: 'short'}, {text: 'Please ask again.'}],
  tooSlowReprompt: [{text: 'Ask again, or say stop.'}],
  trackerUnavailable: [
    {text: 'The tracker is not answering right now.', pauseAfter: 'short'},
    {text: 'Please try again in a minute.'},
  ],
  somethingWentWrong: [
    {text: 'Something went wrong on my side.', pauseAfter: 'short'},
    {text: 'Please try again, or say help.'},
  ],
  genericReprompt: [{text: 'Say help to hear what you can say, or say stop.'}],
  voiceNotRecognised: [
    {text: 'I do not recognise your voice for this skill.', pauseAfter: 'short'},
    {text: 'Say stop, or try again.'},
  ],
  speechCut: 'I had to stop there.',
} as const satisfies {
  linkAccount: readonly SpeechSegment[];
  relinkAccount: readonly SpeechSegment[];
  progressive: string;
  tooSlow: readonly SpeechSegment[];
  tooSlowReprompt: readonly SpeechSegment[];
  trackerUnavailable: readonly SpeechSegment[];
  somethingWentWrong: readonly SpeechSegment[];
  genericReprompt: readonly SpeechSegment[];
  voiceNotRecognised: readonly SpeechSegment[];
  speechCut: string;
};
