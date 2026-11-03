# Trying the voice tracker by typing

This is the first version of the voice tracker. You type what you would say, and it answers in text, and out loud
if you ask it to. It uses a set of made-up sample issues, not a real tracker account, so nothing you do can change
anything. The point is to find out whether the answers are easy to follow and quick to use, before any speaker is
set up.

The commands for the Alexa skill, issue desk, with what it says back, are in the [voice command guide](commands.md).

## Starting it

Open Terminal, go to the youtrack-agents folder, and run:

node src/voice/text/repl.ts --fixture docs/voice/sample-issues.json --say

The --say part makes the Mac speak each answer, using its own voice. Leave it out if you would rather use your screen
reader to read the text.

It says "Tracker ready" when it starts. Type one thing at a time and press Return.

## Things to say

- my issues: hears your list, five at a time, numbered.
- more: the next five. previous: the five before.
- open two: opens number two from the list you last heard. "the second one" and "number 2" work too.
- description, comments, or fields: reads that part of the open issue, a paragraph or a comment at a time. Say more
  to go on.
- where am I: which list, which issue, and how far through it you are.
- repeat: says the last answer again.
- find, then some words from the title: for example, find boiler.
- open issue, then the id spelled out: for example, open issue hotel oscar mike echo nine. When typing, the id alone
  works too: HOME-9.
- in progress issues, open issues, recent issues: other lists.
- brief, normal, or full: how much detail. Brief is the default.
- faster, slower, or normal speed: how fast it talks.
- help: a short reminder of all this.
- stop: finishes.

It does not change anything yet. Saying comment, or set the state, gets the answer "I can't do that yet". Saying yes
or no when nothing was asked gets "There's nothing to confirm".

## Sounds

Short sounds come before some answers, and are also written in the text as, for example, [earcon: success].

- success: something opened or a setting changed.
- failure: it could not do what you asked.
- end of list: there is nothing more to read.

## Picking up where you left off

It remembers your place between runs. Stop it, start it again, and it tells you what you were reading. Say more to
carry on. A list you heard more than 12 hours ago has expired, so it asks you to say "my issues" again rather than
guess which issue a number meant.

## Other options

- --evidence account or --evidence none: pretends the speaker is not recognised, to hear how it refuses.
- --state followed by a folder: keeps your place in that folder instead of the temporary one.
- --timezone followed by a zone such as Europe/London: the zone used for "today" and "yesterday". It uses the
  computer's own zone unless you say otherwise; --timezone none reads every date as a date instead.
- --log info: prints what it is doing to the error output, without any issue text. --log debug includes everything.

## What we would like to hear back

- Any answer that was confusing, too long, or in an order that made it hard to follow.
- Anything you tried to say that it did not understand.
- Whether the numbers, the "paragraph 2 of 3" markers, and the hints like "Say 'more' to go on" help or get in the
  way.
- Whether the speed and the amount of detail are right, and what you would change.
