/**
 * A stand-in for YA-13's `src/voice/core/intents.ts`, shaped exactly like it (`INTENT_CATALOGUE: readonly
 * IntentSpec[]`), so the Alexa model generator can be built and tested before the real catalogue exists. The
 * wording is illustrative; integration swaps the real catalogue in (declared sequencing point, YA-10 packet).
 */
import type {IntentSpec} from '../../../../src/voice/core/types.ts';

export const INTENT_CATALOGUE: readonly IntentSpec[] = [
  {
    name: 'list',
    stage: 1,
    slots: [{name: 'scope', kind: 'enum', values: ['mine', 'in-progress', 'open', 'recent']}],
    samples: ['my issues', 'list {scope} issues', 'what is {scope}', 'read my {scope} list'],
  },
  {
    name: 'find',
    stage: 1,
    slots: [{name: 'words', kind: 'phrase'}],
    samples: ['find {words}', 'search for {words}', 'look for issues about {words}'],
  },
  {
    name: 'open',
    stage: 1,
    slots: [{name: 'ordinal', kind: 'ordinal'}],
    samples: ['open {ordinal}', 'open number {ordinal}', 'open the {ordinal} one'],
  },
  {
    name: 'openById',
    stage: 1,
    slots: [{name: 'spelled', kind: 'spelled'}],
    samples: ['open issue {spelled}', 'go to issue {spelled}'],
  },
  {
    name: 'read',
    stage: 1,
    slots: [{name: 'part', kind: 'enum', values: ['summary', 'description', 'comments', 'fields']}],
    samples: ['read the {part}', 'read {part}'],
  },
  {name: 'more', stage: 1, slots: [], samples: ['more', 'carry on']},
  {name: 'previous', stage: 1, slots: [], samples: ['go back']},
  {name: 'repeat', stage: 1, slots: [], samples: ['say that again']},
  {name: 'where', stage: 1, slots: [], samples: ['where am i', 'what am i on']},
  {name: 'help', stage: 1, slots: [], samples: ['what can i say']},
  {
    name: 'setVerbosity',
    stage: 1,
    slots: [{name: 'level', kind: 'enum', values: ['brief', 'normal', 'full']}],
    samples: ['be {level}', 'set detail to {level}'],
  },
  {
    name: 'setRate',
    stage: 1,
    slots: [{name: 'rate', kind: 'enum', values: ['slower', 'faster', 'normal']}],
    samples: ['speak {rate}', 'talk {rate}'],
  },
  {name: 'cancel', stage: 1, slots: [], samples: []},
  {name: 'stop', stage: 1, slots: [], samples: []},
  {
    name: 'comment',
    stage: 3,
    slots: [{name: 'text', kind: 'phrase'}],
    samples: ['comment {text}', 'add a comment saying {text}'],
  },
  {
    name: 'setState',
    stage: 3,
    slots: [{name: 'state', kind: 'enum', values: ['open', 'in-progress', 'fixed']}],
    samples: ['mark it {state}', 'move it to {state}'],
  },
  {name: 'confirm', stage: 3, slots: [], samples: ['that is right']},
  {name: 'deny', stage: 3, slots: [], samples: ['that is wrong']},
  {
    name: 'create',
    stage: 4,
    slots: [{name: 'summary', kind: 'phrase'}],
    samples: ['new issue', 'create an issue called {summary}'],
  },
  {name: 'dictate', stage: 4, slots: [{name: 'text', kind: 'phrase'}], samples: ['write {text}']},
  {name: 'finishDictation', stage: 4, slots: [], samples: ['finish dictation', 'that is all']},
];
