# Issue desk voice commands

This guide is for everyone in the household who uses issue desk, the Alexa skill that reads the household's issues
aloud. It covers the first trial version, from 13 September 2026. For now the skill only reads. It cannot change
anything yet. It can also tell you the outdoor air quality, from PurpleAir sensors.

How this guide is written:

<!-- intent: list -->

- Words you say are in double quotes, exactly as you say them, for example "my issues".
- What Alexa says back is set apart as a quotation, one line for each part of the answer.
- The example issues, like the piano tuner and the boiler, are made up. You will hear your own. The air quality
  readings are made up too.

<!-- Maintainers: every phrase in double quotes is checked by test/voice/docs/commands.test.ts. It must parse to the
intent named in the nearest intent tag above it, under the same heading. Every quoted reply must be real output from a
transcript or the adapter's messages. The last section is generated: run node src/voice/docs/generate-commands.ts. -->

## Getting started

### Opening the skill

<!-- intent: list open more read -->

On an Echo with Alexa+, start by asking for something, with "ask issue desk":

- "Alexa, ask issue desk for my issues"
- "Alexa, ask issue desk for open issues"
- "Alexa, ask issue desk what's assigned to Chris"

Once it answers, carry on without the wake word ("open one", "more", "read the description") while it is listening.
You can also start a fresh request the same way at any time, such as "Alexa, ask issue desk to open one", and it
remembers the list you last heard.

"Alexa, open issue desk" also works on some devices. On an Echo Dot with Alexa+ it has answered that it isn't
supported on this device. If that happens, use "ask issue desk" instead.

The first time, and whenever you have no list in progress, Alexa says:

> Tracker ready. Say 'my issues', or 'help'.

If you come back within 12 hours of asking for a list, it offers to carry on instead:

> Welcome back.
> Say 'more' to go on with your list, or 'my issues' to start again.

<!-- intent: more -->

If you stopped part way through an issue, it names the issue and what you were reading, and "more" goes on from
there.

After Alexa answers, it listens for a few seconds, so you can say the next command without the wake word. If you say
nothing, it reminds you once what you can say, then closes. To interrupt while it is talking, say the wake word,
Alexa, then your command.

### Short sounds

Some answers start with a short sound:

- A bell chime: something opened, or a setting changed.
- A low buzz: it could not do what you asked. The words after it say why.
- A short tone: you have reached the end of a list or of the part you were reading.

### Stopping

<!-- intent: stop cancel -->

Say "stop" to finish. Alexa says:

> Goodbye.

Say "cancel" or "never mind" to close without another word. Alexa says:

> OK.

Both close the skill. Your place is kept, so the next "Alexa, open issue desk" can pick up where you were.

### What it reads, and who can hear it

- It reads the issues in one tracker project only: H, Household. No other project is ever read.
- Everyone in the household can listen. Alexa does not need to recognise your voice to read issues aloud.
- Anyone who can talk to an Alexa device, or use the Alexa app, on the household's Amazon account can hear what it
  reads. That includes visitors.
- When changing issues by voice arrives, changes will need a voice that Alexa recognises. Reading will stay open to
  everyone.
- Air quality needs no linked account and reads nothing from the tracker. To find where the Echo is, it asks Amazon
  for the Echo's country and postal code only, never the street address, and only when you ask about the air.

## Commands by task

Each command below says what it does, gives a few ways to say it, and quotes what Alexa says back. The last section
of this guide lists every phrasing the skill knows.

### Hearing your issues

#### My issues, and other lists

<!-- intent: list -->

Reads a numbered list of issues, five at a time, starting with how many there are.

You can say:

- "my issues"
- "what am I working on"
- "in progress issues"
- "open issues"
- "recent issues"

The lists are:

- "my issues": open issues assigned to you. For most voices, you means the household account.
- "in progress issues": issues assigned to you that are in progress.
- "open issues": every open issue in the project, whoever it is assigned to.
- "recent issues": the 10 most recently updated issues.

Alexa says back, for example:

> You have 9 issues.
> One: Book the piano tuner before the recital.
> Two: Draft the October community newsletter.
> Three: Compare quotes for the new boiler.
> Four: Renew the home insurance.
> Five: Set up the talking kitchen scales.
> 4 more. Say 'more' to hear them.

<!-- intent: more open where -->

Then you can say "more" for the next few, "open two" to open number two, or "where am I".

#### Someone else's issues

<!-- intent: list -->

Reads the open issues assigned to someone else in the household, by their name. It is the same numbered list as "my
issues", five at a time, starting with how many they have.

You can say:

- "what's assigned to Priya"
- "Priya's issues"
- "issues for Priya Shah"
- "what does Sam have"
- "show me Sam's issues"
- "issues for the household"

A first name is enough when only one person has it. Only people who have open issues in the project can be named,
and Alexa reads each one's name as the tracker has it. Someone whose tracker account has no name set, or whose name is
just their login or an email address, cannot be named by voice: Alexa never reads a login or an email aloud. The
same goes for a full name that looks like a login or an email, such as jo.bloggs. When their issue's fields are read,
you hear the following, and a comment they wrote is read as from someone without a name in the tracker:

> Assigned to someone without a name in the tracker.

"issues for everyone" is the same as "open issues". Closed issues are not read; asking for them gets:

> I can only list open issues. Say 'open issues' to hear them.

Alexa says back, for example:

> Priya Shah has 1 issue.
> One: Plan the allotment open day.

<!-- intent: more open read where -->

Then "more", "open one", "fields" and "where am I" work just as they do for your own list. "where am I" names the
list:

> You're in Priya Shah's issues, 1 issue.

<!-- intent: open -->

If two people share the name you said, Alexa asks which one you mean, as a numbered list. Say the number, for example
"two":

> 2 people match Chris.
> One: Chris Coulter.
> Two: Chris Holloway.
> Say the number of the one you mean.

If the tracker gave only some of the people, the count starts with at least, and the list ends:

> There may be others with that name. Say the number of the one you mean.

If the name only sounds close, or you said only a surname, Alexa checks before reading anything. Answer yes or no, or
say "one" for yes:

> Did you mean Mary Jones?

If nobody by that name has open issues, Alexa says so, and the list you were in stays as it was:

> Nobody called Chris has open issues in this project.
> You're still in Sam Okafor's issues.

If some people could not be checked, because they have no name Alexa can say or there were too many, it says only
what it knows:

> I couldn't find anyone called Zoe, but I can't name everyone in this project.

<!-- intent: list -->

"issues for me", "what's assigned to me" and "my issues" all mean your own issues, as before.

### Finding one

#### Find by words from the title

<!-- intent: find -->

Searches the project for issues whose titles have your words in them, and reads the matches as a numbered list. If
exactly one issue matches all your words, it opens that issue straight away.

You can say:

- "find boiler"
- "search for the recital"
- "look for insurance"
- "is there an issue about the garden gate"

With one match, Alexa opens it:

> 1 issue matches.
> Number 1.
> Compare quotes for the new boiler.
> Open.
> Say 'description', 'comments', or 'fields'.

With more than one, you hear a list:

> 2 issues match.
> One: Book the piano tuner before the recital.
> Two: Write thank you cards after the recital.

With none, you keep the list you had:

> No issues match.
> You're still in the matches for the recital.

If you say "find" with no words, it asks what to look for:

> What should I look for? Say 'find' and some words from the title.

<!-- intent: open read -->

Then you can say "open one", or, after a single match, "description".

### Opening and reading

#### Open by number

<!-- intent: open -->

Opens an issue from the list you heard last, by its number in that list. Alexa says the number, the title and the
state.

You can say:

- "open two"
- "number two"
- "the second one"
- "tell me about number three"

Alexa says back:

> Number 2.
> Draft the October community newsletter.
> In Progress.
> Say 'description', 'comments', or 'fields'.

If the list has no such number:

> There's no number 20. The list has 9.

<!-- intent: read -->

Then you can say "description", "comments" or "fields".

#### Open by id

<!-- intent: openById -->

Opens an issue by its id, spelled out, whatever list you are in. See Numbers and ids, below, for how to say an id.

You can say:

- "open issue hotel twelve"
- "issue hotel one two"
- "the id is hotel twelve"

Alexa says Issue, then the letters one at a time, then the number, then the title and the state. With the example
issues:

> Issue H O M E 12.
> Book the piano tuner before the recital.
> In Progress.
> Say 'description', 'comments', or 'fields'.

<!-- intent: read -->

Then you can say "description", "comments" or "fields". Opening by id does not change the numbers in your list.

#### Read the description, comments or fields

<!-- intent: read -->

Reads one part of the open issue. A description is read a paragraph at a time, and comments one at a time, with who
wrote each one and when.

You can say:

- "read the description"
- "comments"
- "fields"
- "read the title"

Alexa says back, for the description:

> Description, 3 paragraphs.
> Paragraph 1 of 3.
> Sections. A list of 4 items. Welcome from the chair. Allotment open day. Lost and found. Dates for the diary.
> Say 'more' to go on.

For comments:

> 3 comments.
> Comment 1 of 3, from Priya, on 9 September.
> Can we add a note about the new bin collection day? It moves to Thursday from the 1st.
> Say 'more' to go on.

For fields:

> State: In Progress.
> Assigned to Robin Hale.
> Subsystem: Community.
> Updated on 11 September.

For the title, which is useful when a long title was cut short:

> Summary: Draft the October community newsletter.

Links are read as their words, tables as the number of rows, and web addresses and ids are left out.

<!-- intent: more previous -->

Then you can say "more" for the next paragraph or comment, or "previous" to go back.

If no issue is open, reading says:

> No issue is open. Say 'open' and a number first.

### Moving around

#### More

<!-- intent: more -->

Goes on: the next few issues in a list, or the next paragraph or comment of the part you are reading.

You can say:

- "more"
- "next"
- "go on"
- "keep reading"

In a list, Alexa says back:

> Issues 6 to 9 of 9.
> Six: Choose plants for the raised bed.
> Seven: Return the library audiobook players.
> Eight: Update the emergency contact list.
> Nine: Write thank you cards after the recital.
> End of the list.

In a description:

> Paragraph 2 of 3.
> Keep it under 600 words; the printed copy is two sides of A5.

#### Previous

<!-- intent: previous -->

Goes back: the five issues before, or the paragraph or comment before.

You can say:

- "previous"
- "go back"
- "back"

At the top of a list, Alexa says:

> That's the start of the list.

#### Repeat

<!-- intent: repeat -->

Says the last answer again, exactly.

You can say:

- "repeat"
- "say that again"
- "pardon"

#### Where am I

<!-- intent: where -->

Says which list you are in and how far through it you are, or which issue is open and what you are reading.

You can say:

- "where am I"
- "where was I"
- "what issue is this"

In a list, Alexa says back:

> You're in your issues, 9 issues.
> You last heard 1 to 5.

While reading:

> You're in your issues, 9 issues.
> Issue number 2: Draft the October community newsletter.
> Reading the description, paragraph 2 of 3.

### Speed and detail

These settings are kept for next time.

#### Detail

<!-- intent: setVerbosity -->

Changes how much you hear. It starts on brief.

- Brief: lists five at a time, titles only.
- Normal: lists up to ten at a time, with each issue's state.
- Full: lists up to twenty at a time, with each issue's state, and reads as much of a description or comments at once as
  fits.

You can say:

- "brief"
- "normal"
- "full answers"
- "give me detailed answers"

Alexa says back:

> Full answers.

After that, a list sounds like this:

> You have 9 issues.
> One: Book the piano tuner before the recital. In Progress.
> Two: Draft the October community newsletter. In Progress.

#### Speed

<!-- intent: setRate -->

Changes how fast Alexa talks, a quarter faster or slower each time, from half speed to two and a half times normal.

You can say:

- "faster"
- "slower"
- "speak more slowly"
- "normal speed"

Alexa says back:

> Speed 125 percent.

At either end:

> That's as fast as I go: 250 percent.

<!-- intent: setRate setVerbosity -->

Say "normal speed" to go back to normal. Said on its own, "normal" means normal detail, not normal speed.

### Air quality

#### Air quality here

<!-- intent: airQuality -->

Tells you how clean the outdoor air is, from the nearest usable PurpleAir sensor near the Echo. Anyone can ask, even
before the tracker account is linked, because it reads nothing from the tracker.

You can say:

- "Alexa, ask issue desk for the air quality here"
- "air quality here"
- "how's the air at home"
- "is the air okay outside"
- "what's the a. q. i. here"

Alexa says back, for example:

> Air quality near you is Moderate.
> AQI 63, from a 10-minute average from 1 PurpleAir sensor, 902 metres away, updated 14 minutes ago.
> Unusually sensitive people should consider making outdoor activities shorter and less intense.

The first line says where the reading is for and how the air is: Good, Moderate, Unhealthy for sensitive groups,
Unhealthy, Very unhealthy or Hazardous. The second gives the US air quality index, then how many sensors it comes
from, how far around, and how fresh it is. The index usually runs from 0 to 500; in very thick smoke it can go higher,
and is still Hazardous. A last line of advice, from the EPA's advice for each category, comes only when the air is
worse than Good. It never reads a street address, a sensor's number, map coordinates or the Echo's postal code.

The figure is that sensor's last 10 minutes, corrected the way the EPA corrects PurpleAir sensors. The service checks
the wider nearby area before accepting it, so an obviously anomalous closest sensor is skipped. It can differ from the
AirNow website's number, which is averaged over hours, especially while smoke is moving.

Where here is:

- If the skill is allowed to use the Echo's postal code, it uses that, and says near you.
- Otherwise it uses the home location the owner set up, and says at home:

> Air quality at home is Moderate.

- If there is neither, it says so, and how to ask for a town instead:

> I don't know where this device is.
> Say 'air quality in' and a town, or allow this skill to use the device's postal code.

#### Air quality somewhere else

<!-- intent: airQualityPlace -->

Name a town, a postal code, or a PurpleAir sensor by its name.

You can say:

- "Alexa, ask issue desk what's the air quality in Missoula"
- "how's the air in Seeley Lake"
- "air quality in 59802"
- "air quality at Rattlesnake Creek"

It looks near the Echo, or near home, first. It averages the outdoor sensors within 5 kilometres of the place, giving
the nearest ones the most weight. If fewer than three are close, it adds the sensors out to 15 kilometres, and says
when the reading rests on only a few:

> Air quality near Seeley Lake is Moderate.
> AQI 51, from 2 PurpleAir sensors within 15 kilometres, updated 3 minutes ago.
> With so few sensors, take it as a rough guide.
> Unusually sensitive people should consider making outdoor activities shorter and less intense.

A PurpleAir sensor near the Echo or home whose name matches closely comes before a town of the same name far away:

> Air quality at the sensor called Rattlesnake Creek is Good.
> AQI 30, from a 10-minute average from 1 PurpleAir sensor, updated 8 minutes ago.

A town far away is said by its own name and state, so you know which one it found:

> No outdoor sensors are reporting within 15 kilometres of Portland, Oregon.

<!-- intent: airQualityPlace open -->

When there are two or three far-away towns of that name, it asks which, and you answer with a number. A town in
another state is always said with its state:

> Did you mean Springfield, Missouri, or Springfield, Illinois?
> Say 'one' or 'two'.

Say "one", and it answers for that town:

> Air quality near Springfield, Missouri is Good.
> AQI 32, from 3 PurpleAir sensors within 5 kilometres, updated 4 minutes ago.

<!-- intent: airQualityPlace -->

Or say the state too, as in "air quality in Springfield Missouri", and it does not need to ask.

Choosing a place replaces the list of issues you were hearing, the way choosing a person does. Afterwards, "my
issues" brings the list back.

If nothing matches:

> I couldn't find a place or a sensor called Blorp.
> Try the nearest town, or a postal code.

A whole state or country is too big to average, so it is treated as not found.

#### When there is no good reading

<!-- intent: airQualityPlace -->

It says so rather than guess. When the closest sensor reads very differently from the others around it, it says the
worse reading first, then both, and calls it a rough guide:

> Air quality near Hamilton, Montana is Unhealthy for sensitive groups.
> Readings nearby disagree: AQI 135 from 1 sensor, and AQI 27 from 3 others, updated 3 minutes ago.
> Take it as a rough guide.

Sensors that have not reported for a quarter of an hour are not used:

> The newest reading near Polson is 45 minutes old.
> That's too old to give a current reading.

No sensors at all:

> No outdoor sensors are reporting within 15 kilometres of Jordan.

The sensors cannot be reached, or the service is not working:

> I couldn't reach the air sensors. Try again in a moment.

After about 20 questions in 10 minutes from the same voice, or a lot of questions from the whole household, it takes
a short rest, which keeps the sensor service's costs down:

> I've checked the air a lot just now. Try again in a few minutes.

Air quality has not been turned on for the skill:

> Air quality isn't set up for this skill.

<!-- intent: airQualityPlace repeat stop -->

Afterwards it listens for a moment: ask about another place, such as "air quality in Missoula", say "repeat" to hear
it again, or "stop". Asking again within five minutes gives the same reading, without asking the sensors again.

#### Indoor air quality

<!-- intent: airQualityIndoor -->

When the household has configured its indoor PurpleAir sensor, say "what's the air quality inside". Anyone can ask,
even before linking a tracker account. It reads only that configured sensor, caches the fresh reading briefly, and says
when it has not reported recently or cannot be found.

An explicitly selected sensor can report despite low confidence, with a spoken warning that the reading is uncertain.
The nearest outdoor sensor and city averages still exclude low-confidence readings.

### Getting help

#### Help

<!-- intent: help -->

A short reminder of the main commands.

You can say:

- "help"
- "what can I say"
- "what can you do"

Alexa says back:

> You can say: 'my issues', 'issues for' and a name, 'air quality here', 'open' and a number, 'description', 'comments', 'more', 'previous', 'repeat', and 'where am I'.
> To change how I talk, say 'brief', 'normal' or 'full', or 'faster', 'slower' or 'normal speed'. Say 'stop' to finish.

#### Cancel

<!-- intent: cancel -->

Closes the skill quietly. Your place is kept.

You can say:

- "cancel"
- "never mind"
- "forget it"

Alexa says back:

> OK.

#### Stop

<!-- intent: stop -->

Says goodbye and closes the skill. Your place is kept.

You can say:

- "stop"
- "goodbye"
- "I'm done"

Alexa says back:

> Goodbye.

## Numbers and ids

### How the numbered list works

<!-- intent: open -->

- Every list is numbered from one, in the order you hear it.
- A number always means the list you heard last. Saying "open two" opens number two of that list.
- You can say the number plainly, as a position, or with the word number: "open two", "open the second one", "open
  number two".
- Asking for a new list, or finding by words, replaces the numbers. An issue you had open closes, because its number
  belonged to the old list.
- Opening an issue by its id leaves the numbers alone.

### Lists expire

<!-- intent: open where list -->

A list lasts 12 hours from when you asked for it. After that, the skill will not guess which issue a number meant.
Saying "open two" gets:

> That list has expired. Say 'my issues' to hear it again.

And "where am I" gets:

> Your last list has expired. Say 'my issues' to hear it again.

Say "my issues", or whichever list you want, to hear it fresh. An issue you already had open stays open.

### Saying an id

<!-- intent: openById -->

Ids in the household project are the letter H, a dash, and a number, such as H-12. To open one, start with the
words open issue, then spell the id.

- Say the letter with the phonetic alphabet: "open issue hotel twelve".
- Or say the letter's name: "open issue aitch twelve".
- Say the number whole, or digit by digit: "open issue hotel one two".
- Leave out the dash.
- Pausing to say um in the middle is fine: "open issue um hotel twelve" and "open issue hotel um twelve" both open
  H-12.

Ids from other projects spell the same way, for example "open issue yankee alpha one three", but only issues in
project H are ever read.

If there is no issue with that id, Alexa says the id it heard, letter by letter:

> I heard H 99, but there's no issue with that id.

If the letters are missing, for example "open issue twelve", it says how to spell one:

> I couldn't make an id out of that. Spell the letters, then the number, like 'yankee alpha one three'.

## What it won't do yet, and what it refuses

### Changing things

It only reads for now. Asking it to change an issue, add a comment, or create an issue gets:

> I can't do that yet. For now I can only read issues.

See Coming later, at the end, for what is planned.

### Something it didn't catch

<!-- intent: help -->

When it cannot tell what you said, it does nothing, and says:

> I didn't catch that. You can say 'my issues', or 'help'.

Nothing was changed and your place is kept. Try again with one of the phrasings in this guide, or say "help".

### An account link it doesn't recognise

The skill reads through the household's own tracker account. If the Alexa app has been linked to some other tracker
account, or the link has expired or been removed, the skill reads nothing, and says:

> Your tracker account link has expired or was removed.
> I have sent a link card to the Alexa app, so you can link it again.

See Relinking, below.

If no account has been linked at all, it says:

> Your tracker account is not linked yet.
> I have sent a link card to the Alexa app. Open it there to link your account. You only do this once.

## Troubleshooting

### Alexa says the skill is not supported on this device

This happened in testing, before the skill was renamed to issue desk.

- After the skill is changed or rebuilt, wait a few minutes before trying again.
- Check that you said the name exactly: "Alexa, open issue desk".
- Try the same words in the Alexa app on a phone. If it works there, the skill is fine, and the device needs more
  time.
- If it still fails, tell the owner, who can check the logs.

### Nothing is heard

- If Alexa says nothing at all and the light ring does not show it listening, the device did not hear you. Say
  "Alexa, open issue desk" again.
- If Alexa closed after answering, open the skill again. It keeps your place.

If the tracker is slow, you may hear a short wait message, then:

> The tracker is taking too long to answer.
> Please ask again.

If the tracker cannot be reached, you hear one of these. Wait a minute and try again.

> I couldn't reach the tracker. Try again in a moment.

> The tracker is not answering right now.
> Please try again in a minute.

### The wrong issues are read

<!-- intent: list where -->

- "my issues" reads only the issues assigned to the tracker account you are linked as. "open issues" reads
  everyone's, and "issues for Priya" reads one person's.
- A voice that Alexa recognises, and that has been linked to its own tracker account, hears that account's issues.
  Every other voice hears the household account's. So "my issues" can sound different depending on who asks.
- A number always means the list you heard last. Say "where am I" to hear which list that is.
- Only project H is read. An issue in another project cannot be opened.
- If you hear issues that belong to someone else's account, the Alexa app may be linked to the wrong tracker account.
  Tell the owner, who relinks as below.

### Relinking

The Alexa iPhone app cannot link this skill: its link card has no Link Account button, and Link Account in the older
app fails before any sign-in page opens. So linking is done by the owner, outside the Alexa app.

1. Tell the owner what Alexa said.
2. The owner opens a one-time setup page in a private browser window and signs in twice: to Amazon with the household's
   Amazon account, then to the tracker as the household account. The page says it is linked when it worked.
3. Say "Alexa, open issue desk" to check.

The owner's steps are in the Alexa runbook, in its section on linking without the Alexa app.

## For the owner

- One-time setup, deploying and account linking are in the [Alexa runbook](alexa.md). Its step 8 covers
  checking which account each link belongs to, and deleting saved state after a wrong link.
- To follow the logs while someone tries the skill, run this, with the stack's region:

  ```sh
  aws logs tail /aws/lambda/youtrack-voice-alexa --follow --region <region>
  ```

- Air quality: the PurpleAir key, the home location and the Echo's postal-code permission are set up in the Alexa
  runbook, section Air quality (YA-36). If it says at home when the Echo's postal code should be used, the
  permission has not been granted; `alexa.address` in the logs says `not-granted`.
- Useful events at info level: `alexa.request` for each turn, `voice.intent` for what was understood,
  `voice.grammar.unmatched` for something not caught, `voice.binding.loginMismatch` for a link to the wrong account,
  and `alexa.turn.failed` for a failure with its kind.
- To try the commands by typing, with made-up issues, see [Trying the voice tracker by typing](trying-it.md).
- Deploying a change to what can be said: deploy the Lambda first, then the interaction model; to roll back, put the
  old model back first, then the old Lambda. The exact steps are in the Alexa runbook, under "Recover, roll back, tear
  down".
- This guide changes with each hand-off. The last section is regenerated with
  `node src/voice/docs/generate-commands.ts`, and `npm test` fails if it is out of date.

## Coming later

None of these work yet. Each is its own piece of work in the tracker.

- Changing an issue's state, and adding a comment, with the change read back for you to confirm (YA-17).
- Creating an issue and dictating its description (YA-18).
- Hearing what is due soon (YA-30).
- A summary of the current sprint (YA-31).
- Relinking by voice, and noticing a link moved to a different account (YA-28).

Until then, saying yes or no when nothing was asked gets the answer that there is nothing to confirm.

## Every phrasing

Every phrasing the skill knows, command by command, generated from the skill's own list. Where a phrasing takes a
number, an id, a list name, a place or some words, one example is filled in: two, hotel twelve, open, Missoula, or
boiler.

<!-- generated: begin -->

<!-- Written by src/voice/docs/generate-commands.ts from src/voice/core/intents.ts. Do not edit by hand. -->

### Hearing a list of issues

<!-- intent: list -->

- "my issues"
- "list my issues"
- "read my issues"
- "what are my issues"
- "what issues do I have"
- "what's on my list"
- "what's assigned to me"
- "what am I working on"
- "list issues"
- "issues"
- "open issues"
- "list open issues"
- "read open issues"
- "read me open issues"
- "what are open issues"
- "what's open"
- "show open issues"
- "list the open ones"
- "what's assigned to Priya"
- "Priya's issues"
- "show me Priya's issues"
- "issues for Priya"
- "issues assigned to Priya"
- "what does Priya have"
- "what's Priya working on"

Other words work in the same places. Here they are in "list open issues":

Your own open issues:

- "list my issues"
- "list mine issues"
- "list my open issues"
- "list assigned to me issues"

Your issues in progress:

- "list in progress issues"
- "list active issues"
- "list started issues"
- "list my active issues"

All open issues:

- "list open issues"
- "list unresolved issues"
- "list all open issues"

The most recently updated:

- "list recent issues"
- "list recently updated issues"
- "list latest issues"

### Finding an issue by words from its title

<!-- intent: find -->

- "find"
- "search"
- "find boiler"
- "search for boiler"
- "search boiler"
- "look for boiler"
- "find issues about boiler"
- "find the one about boiler"
- "open the one about boiler"
- "the one about boiler"
- "which issue is about boiler"
- "is there an issue about boiler"

### Opening an issue by its number in the list

<!-- intent: open -->

- "open two"
- "open number two"
- "number two"
- "two"
- "go to two"
- "go to number two"
- "tell me about two"
- "tell me about number two"
- "read two"
- "read number two"
- "pick two"
- "choose two"
- "select two"
- "what's number two"

### Opening an issue by its id

<!-- intent: openById -->

- "open issue hotel twelve"
- "issue hotel twelve"
- "open id hotel twelve"
- "go to issue hotel twelve"
- "find issue hotel twelve"
- "spell hotel twelve"
- "the id is hotel twelve"
- "open the issue spelled hotel twelve"

### Reading part of the open issue

<!-- intent: read -->

- "comments"
- "read the comments"
- "read comments"
- "read me the comments"
- "what's the comments"
- "what are the comments"
- "tell me the comments"
- "go to the comments"
- "any comments"
- "read it"
- "read this one"
- "what's it about"

Other words work in the same places. Here they are in "read the comments":

The title:

- "read the summary"
- "read the title"
- "read the headline"

The description:

- "read the description"
- "read the details"
- "read the body"

The comments:

- "read the comments"
- "read the discussion"
- "read the replies"

The fields:

- "read the fields"
- "read the status"
- "read the state"
- "read the info"
- "read the information"
- "read the properties"

### More

<!-- intent: more -->

- "more"
- "tell me more"
- "next"
- "next page"
- "next one"
- "continue"
- "go on"
- "carry on"
- "keep going"
- "keep reading"
- "resume"
- "what's next"

### Previous

<!-- intent: previous -->

- "previous"
- "previous page"
- "go back"
- "back"
- "back up"
- "before that"
- "what came before"

### Repeat

<!-- intent: repeat -->

- "repeat"
- "repeat that"
- "say that again"
- "say it again"
- "again"
- "what did you say"
- "come again"
- "pardon"
- "sorry"
- "what"

### Where am I

<!-- intent: where -->

- "where am I"
- "where was I"
- "where are we"
- "what am I reading"
- "what issue is this"
- "which issue is this"
- "what list is this"

### Help

<!-- intent: help -->

- "help"
- "help me"
- "I need help"
- "what can I say"
- "what can I do"
- "what can you do"
- "options"
- "commands"
- "how does this work"

### Detail: brief, normal or full

<!-- intent: setVerbosity -->

- "brief"
- "be brief"
- "brief mode"
- "switch to brief mode"
- "use brief mode"
- "set verbosity to brief"
- "verbosity brief"
- "brief answers"
- "give me brief answers"
- "make answers brief"

Other words work in the same places. Here they are in "brief answers":

Brief:

- "brief answers"
- "short answers"
- "shorter answers"
- "terse answers"

Normal:

- "normal answers"
- "medium answers"
- "standard answers"
- "default answers"

Full:

- "full answers"
- "long answers"
- "longer answers"
- "detailed answers"
- "verbose answers"

### Speed: faster, slower or normal speed

<!-- intent: setRate -->

- "slower"
- "talk slower"
- "speak slower"
- "go slower"
- "set speed to slower"
- "set the rate to slower"
- "speech rate slower"
- "speaking speed slower"

Other words work in the same places. Here they are in "slower":

Slower:

- "slower"
- "slow down"
- "more slowly"

Faster:

- "faster"
- "speed up"
- "quicker"
- "more quickly"

Normal speed:

- "normal speed"
- "default speed"
- "regular speed"
- "normal rate"

### Cancel

<!-- intent: cancel -->

- "cancel"
- "never mind"
- "forget it"
- "forget that"

### Stop

<!-- intent: stop -->

- "stop"
- "exit"
- "quit"
- "goodbye"
- "bye"
- "that's all"
- "I'm done"
- "enough"
- "shut up"

### Air quality

<!-- intent: airQuality -->

- "air quality here"
- "air quality at home"
- "air quality outside"
- "air quality around here"
- "what's the air quality here"
- "what's the air quality at home"
- "what's the air quality outside"
- "what's the air quality around here"
- "what's the air like here"
- "what's the air like at home"
- "how's the air here"
- "how's the air at home"
- "how's the air outside"
- "how's the air quality here"
- "is the air okay here"
- "is the air good here"
- "is the air okay outside"
- "how is the air here"
- "check the air quality here"
- "tell me the air quality here"
- "a. q. i. here"
- "what's the a. q. i. here"
- "air quality outside my house"
- "air quality outside my home"
- "air quality near me"
- "air quality in my neighborhood"
- "air quality in my neighbourhood"
- "what's the air quality outside my house"
- "what's the air quality outside my home"
- "what's the air quality near me"
- "what's the air quality in my neighborhood"
- "what's the air quality in my neighbourhood"
- "what is the air quality here"
- "what is the air quality at home"
- "what is the air quality outside"
- "what is the air quality outside my house"
- "what is the air quality outside my home"
- "what is the air quality around here"
- "what is the air quality near me"
- "what is the air quality in my neighborhood"
- "what is the air quality in my neighbourhood"
- "what the air quality is here"
- "what the air quality is at home"
- "what the air quality is outside"
- "what the air quality is outside my house"
- "what the air quality is outside my home"
- "what the air quality is around here"
- "what the air quality is near me"
- "what the air quality is in my neighborhood"
- "what the air quality is in my neighbourhood"
- "what the air quality is like here"
- "what the air quality is like at home"
- "what the air quality is like outside"
- "what the air quality is like outside my house"
- "what the air quality is like outside my home"
- "what the air quality is like around here"
- "what the air quality is like near me"
- "what the air quality is like in my neighborhood"
- "what the air quality is like in my neighbourhood"
- "what air quality is here"
- "what air quality is at home"
- "what air quality is outside"
- "what air quality is outside my house"
- "what air quality is outside my home"
- "what air quality is around here"
- "what air quality is near me"
- "what air quality is in my neighborhood"
- "what air quality is in my neighbourhood"
- "what's the air like outside"
- "what's the air like outside my house"
- "what's the air like outside my home"
- "what's the air like around here"
- "what's the air like near me"
- "what's the air like in my neighborhood"
- "what's the air like in my neighbourhood"
- "what is the air like here"
- "what is the air like at home"
- "what is the air like outside"
- "what is the air like outside my house"
- "what is the air like outside my home"
- "what is the air like around here"
- "what is the air like near me"
- "what is the air like in my neighborhood"
- "what is the air like in my neighbourhood"
- "what the air is like here"
- "what the air is like at home"
- "what the air is like outside"
- "what the air is like outside my house"
- "what the air is like outside my home"
- "what the air is like around here"
- "what the air is like near me"
- "what the air is like in my neighborhood"
- "what the air is like in my neighbourhood"
- "how's the air outside my house"
- "how's the air outside my home"
- "how's the air around here"
- "how's the air near me"
- "how's the air in my neighborhood"
- "how's the air in my neighbourhood"
- "how is the air at home"
- "how is the air outside"
- "how is the air outside my house"
- "how is the air outside my home"
- "how is the air around here"
- "how is the air near me"
- "how is the air in my neighborhood"
- "how is the air in my neighbourhood"
- "how's the air quality at home"
- "how's the air quality outside"
- "how's the air quality outside my house"
- "how's the air quality outside my home"
- "how's the air quality around here"
- "how's the air quality near me"
- "how's the air quality in my neighborhood"
- "how's the air quality in my neighbourhood"
- "how is the air quality here"
- "how is the air quality at home"
- "how is the air quality outside"
- "how is the air quality outside my house"
- "how is the air quality outside my home"
- "how is the air quality around here"
- "how is the air quality near me"
- "how is the air quality in my neighborhood"
- "how is the air quality in my neighbourhood"
- "how good is the air quality here"
- "how good is the air quality at home"
- "how good is the air quality outside"
- "how good is the air quality outside my house"
- "how good is the air quality outside my home"
- "how good is the air quality around here"
- "how good is the air quality near me"
- "how good is the air quality in my neighborhood"
- "how good is the air quality in my neighbourhood"
- "is the air okay at home"
- "is the air okay outside my house"
- "is the air okay outside my home"
- "is the air okay around here"
- "is the air okay near me"
- "is the air okay in my neighborhood"
- "is the air okay in my neighbourhood"
- "is the air good at home"
- "is the air good outside"
- "is the air good outside my house"
- "is the air good outside my home"
- "is the air good around here"
- "is the air good near me"
- "is the air good in my neighborhood"
- "is the air good in my neighbourhood"
- "check the air quality at home"
- "check the air quality outside"
- "check the air quality outside my house"
- "check the air quality outside my home"
- "check the air quality around here"
- "check the air quality near me"
- "check the air quality in my neighborhood"
- "check the air quality in my neighbourhood"
- "tell me the air quality at home"
- "tell me the air quality outside"
- "tell me the air quality outside my house"
- "tell me the air quality outside my home"
- "tell me the air quality around here"
- "tell me the air quality near me"
- "tell me the air quality in my neighborhood"
- "tell me the air quality in my neighbourhood"
- "tell me what the air quality is here"
- "tell me what the air quality is at home"
- "tell me what the air quality is outside"
- "tell me what the air quality is outside my house"
- "tell me what the air quality is outside my home"
- "tell me what the air quality is around here"
- "tell me what the air quality is near me"
- "tell me what the air quality is in my neighborhood"
- "tell me what the air quality is in my neighbourhood"
- "tell me what the air is like here"
- "tell me what the air is like at home"
- "tell me what the air is like outside"
- "tell me what the air is like outside my house"
- "tell me what the air is like outside my home"
- "tell me what the air is like around here"
- "tell me what the air is like near me"
- "tell me what the air is like in my neighborhood"
- "tell me what the air is like in my neighbourhood"
- "give me the air quality here"
- "give me the air quality at home"
- "give me the air quality outside"
- "give me the air quality outside my house"
- "give me the air quality outside my home"
- "give me the air quality around here"
- "give me the air quality near me"
- "give me the air quality in my neighborhood"
- "give me the air quality in my neighbourhood"
- "give me an air quality report here"
- "give me an air quality report at home"
- "give me an air quality report outside"
- "give me an air quality report outside my house"
- "give me an air quality report outside my home"
- "give me an air quality report around here"
- "give me an air quality report near me"
- "give me an air quality report in my neighborhood"
- "give me an air quality report in my neighbourhood"
- "can you check the air quality here"
- "can you check the air quality at home"
- "can you check the air quality outside"
- "can you check the air quality outside my house"
- "can you check the air quality outside my home"
- "can you check the air quality around here"
- "can you check the air quality near me"
- "can you check the air quality in my neighborhood"
- "can you check the air quality in my neighbourhood"
- "can you tell me what the air quality is here"
- "can you tell me what the air quality is at home"
- "can you tell me what the air quality is outside"
- "can you tell me what the air quality is outside my house"
- "can you tell me what the air quality is outside my home"
- "can you tell me what the air quality is around here"
- "can you tell me what the air quality is near me"
- "can you tell me what the air quality is in my neighborhood"
- "can you tell me what the air quality is in my neighbourhood"
- "please check the air quality here"
- "please check the air quality at home"
- "please check the air quality outside"
- "please check the air quality outside my house"
- "please check the air quality outside my home"
- "please check the air quality around here"
- "please check the air quality near me"
- "please check the air quality in my neighborhood"
- "please check the air quality in my neighbourhood"
- "current air quality here"
- "current air quality at home"
- "current air quality outside"
- "current air quality outside my house"
- "current air quality outside my home"
- "current air quality around here"
- "current air quality near me"
- "current air quality in my neighborhood"
- "current air quality in my neighbourhood"
- "what's the current air quality here"
- "what's the current air quality at home"
- "what's the current air quality outside"
- "what's the current air quality outside my house"
- "what's the current air quality outside my home"
- "what's the current air quality around here"
- "what's the current air quality near me"
- "what's the current air quality in my neighborhood"
- "what's the current air quality in my neighbourhood"
- "what the current air quality is here"
- "what the current air quality is at home"
- "what the current air quality is outside"
- "what the current air quality is outside my house"
- "what the current air quality is outside my home"
- "what the current air quality is around here"
- "what the current air quality is near me"
- "what the current air quality is in my neighborhood"
- "what the current air quality is in my neighbourhood"
- "what is the air quality right now here"
- "what is the air quality right now at home"
- "what is the air quality right now outside"
- "what is the air quality right now outside my house"
- "what is the air quality right now outside my home"
- "what is the air quality right now around here"
- "what is the air quality right now near me"
- "what is the air quality right now in my neighborhood"
- "what is the air quality right now in my neighbourhood"
- "what is the air quality today here"
- "what is the air quality today at home"
- "what is the air quality today outside"
- "what is the air quality today outside my house"
- "what is the air quality today outside my home"
- "what is the air quality today around here"
- "what is the air quality today near me"
- "what is the air quality today in my neighborhood"
- "what is the air quality today in my neighbourhood"
- "a. q. i. at home"
- "a. q. i. outside"
- "a. q. i. outside my house"
- "a. q. i. outside my home"
- "a. q. i. around here"
- "a. q. i. near me"
- "a. q. i. in my neighborhood"
- "a. q. i. in my neighbourhood"
- "what's the a. q. i. at home"
- "what's the a. q. i. outside"
- "what's the a. q. i. outside my house"
- "what's the a. q. i. outside my home"
- "what's the a. q. i. around here"
- "what's the a. q. i. near me"
- "what's the a. q. i. in my neighborhood"
- "what's the a. q. i. in my neighbourhood"
- "what is the a. q. i. here"
- "what is the a. q. i. at home"
- "what is the a. q. i. outside"
- "what is the a. q. i. outside my house"
- "what is the a. q. i. outside my home"
- "what is the a. q. i. around here"
- "what is the a. q. i. near me"
- "what is the a. q. i. in my neighborhood"
- "what is the a. q. i. in my neighbourhood"
- "what the a. q. i. is here"
- "what the a. q. i. is at home"
- "what the a. q. i. is outside"
- "what the a. q. i. is outside my house"
- "what the a. q. i. is outside my home"
- "what the a. q. i. is around here"
- "what the a. q. i. is near me"
- "what the a. q. i. is in my neighborhood"
- "what the a. q. i. is in my neighbourhood"
- "tell me the a. q. i. here"
- "tell me the a. q. i. at home"
- "tell me the a. q. i. outside"
- "tell me the a. q. i. outside my house"
- "tell me the a. q. i. outside my home"
- "tell me the a. q. i. around here"
- "tell me the a. q. i. near me"
- "tell me the a. q. i. in my neighborhood"
- "tell me the a. q. i. in my neighbourhood"
- "check the a. q. i. here"
- "check the a. q. i. at home"
- "check the a. q. i. outside"
- "check the a. q. i. outside my house"
- "check the a. q. i. outside my home"
- "check the a. q. i. around here"
- "check the a. q. i. near me"
- "check the a. q. i. in my neighborhood"
- "check the a. q. i. in my neighbourhood"
- "current a. q. i. here"
- "current a. q. i. at home"
- "current a. q. i. outside"
- "current a. q. i. outside my house"
- "current a. q. i. outside my home"
- "current a. q. i. around here"
- "current a. q. i. near me"
- "current a. q. i. in my neighborhood"
- "current a. q. i. in my neighbourhood"
- "air quality index here"
- "air quality index at home"
- "air quality index outside"
- "air quality index outside my house"
- "air quality index outside my home"
- "air quality index around here"
- "air quality index near me"
- "air quality index in my neighborhood"
- "air quality index in my neighbourhood"
- "what is the air quality index here"
- "what is the air quality index at home"
- "what is the air quality index outside"
- "what is the air quality index outside my house"
- "what is the air quality index outside my home"
- "what is the air quality index around here"
- "what is the air quality index near me"
- "what is the air quality index in my neighborhood"
- "what is the air quality index in my neighbourhood"
- "what the air quality index is here"
- "what the air quality index is at home"
- "what the air quality index is outside"
- "what the air quality index is outside my house"
- "what the air quality index is outside my home"
- "what the air quality index is around here"
- "what the air quality index is near me"
- "what the air quality index is in my neighborhood"
- "what the air quality index is in my neighbourhood"
- "outdoor air quality"
- "what's the outdoor air quality"
- "what is the outdoor air quality"
- "tell me the outdoor air quality"
- "check the outdoor air quality"
- "please check the outdoor air quality"
- "what the outdoor air quality is"
- "outside air quality"
- "what's the outside air quality"
- "what is the outside air quality"
- "tell me the outside air quality"
- "check the outside air quality"
- "please check the outside air quality"
- "what the outside air quality is"
- "air quality from my outdoor sensor"
- "what's the air quality from my outdoor sensor"
- "what is the air quality from my outdoor sensor"
- "tell me the air quality from my outdoor sensor"
- "check the air quality from my outdoor sensor"
- "please check the air quality from my outdoor sensor"
- "what the air quality from my outdoor sensor is"

### Air quality in a place

<!-- intent: airQualityPlace -->

- "air quality in Missoula"
- "air quality near Missoula"
- "air quality at Missoula"
- "air quality for Missoula"
- "what's the air quality in Missoula"
- "what the air quality is in Missoula"
- "what the air quality is like in Missoula"
- "what air quality is in Missoula"
- "what's the air quality near Missoula"
- "what's the air quality at Missoula"
- "what's the air like in Missoula"
- "how's the air in Missoula"
- "how's the air quality in Missoula"
- "is the air okay in Missoula"
- "what's the a. q. i. in Missoula"
- "air quality is Missoula"
- "air quality Missoula"
- "air quality for zip code Missoula"
- "air quality for postcode Missoula"
- "air quality for postal code Missoula"
- "what's the air quality for Missoula"
- "what's the air quality for zip code Missoula"
- "what's the air quality for postcode Missoula"
- "what's the air quality for postal code Missoula"
- "what is the air quality in Missoula"
- "what is the air quality near Missoula"
- "what is the air quality at Missoula"
- "what is the air quality for Missoula"
- "what is the air quality for zip code Missoula"
- "what is the air quality for postcode Missoula"
- "what is the air quality for postal code Missoula"
- "what the air quality is near Missoula"
- "what the air quality is at Missoula"
- "what the air quality is for Missoula"
- "what the air quality is for zip code Missoula"
- "what the air quality is for postcode Missoula"
- "what the air quality is for postal code Missoula"
- "what the air quality is like near Missoula"
- "what the air quality is like at Missoula"
- "what the air quality is like for Missoula"
- "what the air quality is like for zip code Missoula"
- "what the air quality is like for postcode Missoula"
- "what the air quality is like for postal code Missoula"
- "what air quality is near Missoula"
- "what air quality is at Missoula"
- "what air quality is for Missoula"
- "what air quality is for zip code Missoula"
- "what air quality is for postcode Missoula"
- "what air quality is for postal code Missoula"
- "what's the air like near Missoula"
- "what's the air like at Missoula"
- "what's the air like for Missoula"
- "what's the air like for zip code Missoula"
- "what's the air like for postcode Missoula"
- "what's the air like for postal code Missoula"
- "what is the air like in Missoula"
- "what is the air like near Missoula"
- "what is the air like at Missoula"
- "what is the air like for Missoula"
- "what is the air like for zip code Missoula"
- "what is the air like for postcode Missoula"
- "what is the air like for postal code Missoula"
- "what the air is like in Missoula"
- "what the air is like near Missoula"
- "what the air is like at Missoula"
- "what the air is like for Missoula"
- "what the air is like for zip code Missoula"
- "what the air is like for postcode Missoula"
- "what the air is like for postal code Missoula"
- "how's the air near Missoula"
- "how's the air at Missoula"
- "how's the air for Missoula"
- "how's the air for zip code Missoula"
- "how's the air for postcode Missoula"
- "how's the air for postal code Missoula"
- "how is the air in Missoula"
- "how is the air near Missoula"
- "how is the air at Missoula"
- "how is the air for Missoula"
- "how is the air for zip code Missoula"
- "how is the air for postcode Missoula"
- "how is the air for postal code Missoula"
- "how's the air quality near Missoula"
- "how's the air quality at Missoula"
- "how's the air quality for Missoula"
- "how's the air quality for zip code Missoula"
- "how's the air quality for postcode Missoula"
- "how's the air quality for postal code Missoula"
- "how is the air quality in Missoula"
- "how is the air quality near Missoula"
- "how is the air quality at Missoula"
- "how is the air quality for Missoula"
- "how is the air quality for zip code Missoula"
- "how is the air quality for postcode Missoula"
- "how is the air quality for postal code Missoula"
- "how good is the air quality in Missoula"
- "how good is the air quality near Missoula"
- "how good is the air quality at Missoula"
- "how good is the air quality for Missoula"
- "how good is the air quality for zip code Missoula"
- "how good is the air quality for postcode Missoula"
- "how good is the air quality for postal code Missoula"
- "is the air okay near Missoula"
- "is the air okay at Missoula"
- "is the air okay for Missoula"
- "is the air okay for zip code Missoula"
- "is the air okay for postcode Missoula"
- "is the air okay for postal code Missoula"
- "is the air good in Missoula"
- "is the air good near Missoula"
- "is the air good at Missoula"
- "is the air good for Missoula"
- "is the air good for zip code Missoula"
- "is the air good for postcode Missoula"
- "is the air good for postal code Missoula"
- "check the air quality in Missoula"
- "check the air quality near Missoula"
- "check the air quality at Missoula"
- "check the air quality for Missoula"
- "check the air quality for zip code Missoula"
- "check the air quality for postcode Missoula"
- "check the air quality for postal code Missoula"
- "tell me the air quality in Missoula"
- "tell me the air quality near Missoula"
- "tell me the air quality at Missoula"
- "tell me the air quality for Missoula"
- "tell me the air quality for zip code Missoula"
- "tell me the air quality for postcode Missoula"
- "tell me the air quality for postal code Missoula"
- "tell me what the air quality is in Missoula"
- "tell me what the air quality is near Missoula"
- "tell me what the air quality is at Missoula"
- "tell me what the air quality is for Missoula"
- "tell me what the air quality is for zip code Missoula"
- "tell me what the air quality is for postcode Missoula"
- "tell me what the air quality is for postal code Missoula"
- "tell me what the air is like in Missoula"
- "tell me what the air is like near Missoula"
- "tell me what the air is like at Missoula"
- "tell me what the air is like for Missoula"
- "tell me what the air is like for zip code Missoula"
- "tell me what the air is like for postcode Missoula"
- "tell me what the air is like for postal code Missoula"
- "give me the air quality in Missoula"
- "give me the air quality near Missoula"
- "give me the air quality at Missoula"
- "give me the air quality for Missoula"
- "give me the air quality for zip code Missoula"
- "give me the air quality for postcode Missoula"
- "give me the air quality for postal code Missoula"
- "give me an air quality report in Missoula"
- "give me an air quality report near Missoula"
- "give me an air quality report at Missoula"
- "give me an air quality report for Missoula"
- "give me an air quality report for zip code Missoula"
- "give me an air quality report for postcode Missoula"
- "give me an air quality report for postal code Missoula"
- "can you check the air quality in Missoula"
- "can you check the air quality near Missoula"
- "can you check the air quality at Missoula"
- "can you check the air quality for Missoula"
- "can you check the air quality for zip code Missoula"
- "can you check the air quality for postcode Missoula"
- "can you check the air quality for postal code Missoula"
- "can you tell me what the air quality is in Missoula"
- "can you tell me what the air quality is near Missoula"
- "can you tell me what the air quality is at Missoula"
- "can you tell me what the air quality is for Missoula"
- "can you tell me what the air quality is for zip code Missoula"
- "can you tell me what the air quality is for postcode Missoula"
- "can you tell me what the air quality is for postal code Missoula"
- "please check the air quality in Missoula"
- "please check the air quality near Missoula"
- "please check the air quality at Missoula"
- "please check the air quality for Missoula"
- "please check the air quality for zip code Missoula"
- "please check the air quality for postcode Missoula"
- "please check the air quality for postal code Missoula"
- "current air quality in Missoula"
- "current air quality near Missoula"
- "current air quality at Missoula"
- "current air quality for Missoula"
- "current air quality for zip code Missoula"
- "current air quality for postcode Missoula"
- "current air quality for postal code Missoula"
- "what's the current air quality in Missoula"
- "what's the current air quality near Missoula"
- "what's the current air quality at Missoula"
- "what's the current air quality for Missoula"
- "what's the current air quality for zip code Missoula"
- "what's the current air quality for postcode Missoula"
- "what's the current air quality for postal code Missoula"
- "what the current air quality is in Missoula"
- "what the current air quality is near Missoula"
- "what the current air quality is at Missoula"
- "what the current air quality is for Missoula"
- "what the current air quality is for zip code Missoula"
- "what the current air quality is for postcode Missoula"
- "what the current air quality is for postal code Missoula"
- "what is the air quality right now in Missoula"
- "what is the air quality right now near Missoula"
- "what is the air quality right now at Missoula"
- "what is the air quality right now for Missoula"
- "what is the air quality right now for zip code Missoula"
- "what is the air quality right now for postcode Missoula"
- "what is the air quality right now for postal code Missoula"
- "what is the air quality today in Missoula"
- "what is the air quality today near Missoula"
- "what is the air quality today at Missoula"
- "what is the air quality today for Missoula"
- "what is the air quality today for zip code Missoula"
- "what is the air quality today for postcode Missoula"
- "what is the air quality today for postal code Missoula"
- "a. q. i. in Missoula"
- "a. q. i. near Missoula"
- "a. q. i. at Missoula"
- "a. q. i. for Missoula"
- "a. q. i. for zip code Missoula"
- "a. q. i. for postcode Missoula"
- "a. q. i. for postal code Missoula"
- "what's the a. q. i. near Missoula"
- "what's the a. q. i. at Missoula"
- "what's the a. q. i. for Missoula"
- "what's the a. q. i. for zip code Missoula"
- "what's the a. q. i. for postcode Missoula"
- "what's the a. q. i. for postal code Missoula"
- "what is the a. q. i. in Missoula"
- "what is the a. q. i. near Missoula"
- "what is the a. q. i. at Missoula"
- "what is the a. q. i. for Missoula"
- "what is the a. q. i. for zip code Missoula"
- "what is the a. q. i. for postcode Missoula"
- "what is the a. q. i. for postal code Missoula"
- "what the a. q. i. is in Missoula"
- "what the a. q. i. is near Missoula"
- "what the a. q. i. is at Missoula"
- "what the a. q. i. is for Missoula"
- "what the a. q. i. is for zip code Missoula"
- "what the a. q. i. is for postcode Missoula"
- "what the a. q. i. is for postal code Missoula"
- "tell me the a. q. i. in Missoula"
- "tell me the a. q. i. near Missoula"
- "tell me the a. q. i. at Missoula"
- "tell me the a. q. i. for Missoula"
- "tell me the a. q. i. for zip code Missoula"
- "tell me the a. q. i. for postcode Missoula"
- "tell me the a. q. i. for postal code Missoula"
- "check the a. q. i. in Missoula"
- "check the a. q. i. near Missoula"
- "check the a. q. i. at Missoula"
- "check the a. q. i. for Missoula"
- "check the a. q. i. for zip code Missoula"
- "check the a. q. i. for postcode Missoula"
- "check the a. q. i. for postal code Missoula"
- "current a. q. i. in Missoula"
- "current a. q. i. near Missoula"
- "current a. q. i. at Missoula"
- "current a. q. i. for Missoula"
- "current a. q. i. for zip code Missoula"
- "current a. q. i. for postcode Missoula"
- "current a. q. i. for postal code Missoula"
- "air quality index in Missoula"
- "air quality index near Missoula"
- "air quality index at Missoula"
- "air quality index for Missoula"
- "air quality index for zip code Missoula"
- "air quality index for postcode Missoula"
- "air quality index for postal code Missoula"
- "what is the air quality index in Missoula"
- "what is the air quality index near Missoula"
- "what is the air quality index at Missoula"
- "what is the air quality index for Missoula"
- "what is the air quality index for zip code Missoula"
- "what is the air quality index for postcode Missoula"
- "what is the air quality index for postal code Missoula"
- "what the air quality index is in Missoula"
- "what the air quality index is near Missoula"
- "what the air quality index is at Missoula"
- "what the air quality index is for Missoula"
- "what the air quality index is for zip code Missoula"
- "what the air quality index is for postcode Missoula"
- "what the air quality index is for postal code Missoula"
- "air quality from sensor Missoula"
- "air quality at sensor Missoula"
- "what's the air quality from sensor Missoula"
- "what's the air quality at sensor Missoula"
- "what the air quality is from sensor Missoula"
- "what the air quality is at sensor Missoula"
- "check the air quality from sensor Missoula"
- "check the air quality at sensor Missoula"

### Indoor air quality

<!-- intent: airQualityIndoor -->

- "air quality inside"
- "what's the air quality inside"
- "inside air quality"
- "how's the air inside"
- "indoor air quality"
- "what's the air like indoors"
- "air quality indoors"
- "air quality inside my house"
- "air quality inside my home"
- "air quality in my house"
- "air quality in my home"
- "air quality in the house"
- "air quality inside my apartment"
- "air quality in my apartment"
- "air quality inside my flat"
- "air quality in my flat"
- "what's the air quality indoors"
- "what's the air quality inside my house"
- "what's the air quality inside my home"
- "what's the air quality in my house"
- "what's the air quality in my home"
- "what's the air quality in the house"
- "what's the air quality inside my apartment"
- "what's the air quality in my apartment"
- "what's the air quality inside my flat"
- "what's the air quality in my flat"
- "what is the air quality inside"
- "what is the air quality indoors"
- "what is the air quality inside my house"
- "what is the air quality inside my home"
- "what is the air quality in my house"
- "what is the air quality in my home"
- "what is the air quality in the house"
- "what is the air quality inside my apartment"
- "what is the air quality in my apartment"
- "what is the air quality inside my flat"
- "what is the air quality in my flat"
- "what the air quality is inside"
- "what the air quality is indoors"
- "what the air quality is inside my house"
- "what the air quality is inside my home"
- "what the air quality is in my house"
- "what the air quality is in my home"
- "what the air quality is in the house"
- "what the air quality is inside my apartment"
- "what the air quality is in my apartment"
- "what the air quality is inside my flat"
- "what the air quality is in my flat"
- "what the air quality is like inside"
- "what the air quality is like indoors"
- "what the air quality is like inside my house"
- "what the air quality is like inside my home"
- "what the air quality is like in my house"
- "what the air quality is like in my home"
- "what the air quality is like in the house"
- "what the air quality is like inside my apartment"
- "what the air quality is like in my apartment"
- "what the air quality is like inside my flat"
- "what the air quality is like in my flat"
- "what air quality is inside"
- "what air quality is indoors"
- "what air quality is inside my house"
- "what air quality is inside my home"
- "what air quality is in my house"
- "what air quality is in my home"
- "what air quality is in the house"
- "what air quality is inside my apartment"
- "what air quality is in my apartment"
- "what air quality is inside my flat"
- "what air quality is in my flat"
- "what's the air like inside"
- "what's the air like inside my house"
- "what's the air like inside my home"
- "what's the air like in my house"
- "what's the air like in my home"
- "what's the air like in the house"
- "what's the air like inside my apartment"
- "what's the air like in my apartment"
- "what's the air like inside my flat"
- "what's the air like in my flat"
- "what is the air like inside"
- "what is the air like indoors"
- "what is the air like inside my house"
- "what is the air like inside my home"
- "what is the air like in my house"
- "what is the air like in my home"
- "what is the air like in the house"
- "what is the air like inside my apartment"
- "what is the air like in my apartment"
- "what is the air like inside my flat"
- "what is the air like in my flat"
- "what the air is like inside"
- "what the air is like indoors"
- "what the air is like inside my house"
- "what the air is like inside my home"
- "what the air is like in my house"
- "what the air is like in my home"
- "what the air is like in the house"
- "what the air is like inside my apartment"
- "what the air is like in my apartment"
- "what the air is like inside my flat"
- "what the air is like in my flat"
- "how's the air indoors"
- "how's the air inside my house"
- "how's the air inside my home"
- "how's the air in my house"
- "how's the air in my home"
- "how's the air in the house"
- "how's the air inside my apartment"
- "how's the air in my apartment"
- "how's the air inside my flat"
- "how's the air in my flat"
- "how is the air inside"
- "how is the air indoors"
- "how is the air inside my house"
- "how is the air inside my home"
- "how is the air in my house"
- "how is the air in my home"
- "how is the air in the house"
- "how is the air inside my apartment"
- "how is the air in my apartment"
- "how is the air inside my flat"
- "how is the air in my flat"
- "how's the air quality inside"
- "how's the air quality indoors"
- "how's the air quality inside my house"
- "how's the air quality inside my home"
- "how's the air quality in my house"
- "how's the air quality in my home"
- "how's the air quality in the house"
- "how's the air quality inside my apartment"
- "how's the air quality in my apartment"
- "how's the air quality inside my flat"
- "how's the air quality in my flat"
- "how is the air quality inside"
- "how is the air quality indoors"
- "how is the air quality inside my house"
- "how is the air quality inside my home"
- "how is the air quality in my house"
- "how is the air quality in my home"
- "how is the air quality in the house"
- "how is the air quality inside my apartment"
- "how is the air quality in my apartment"
- "how is the air quality inside my flat"
- "how is the air quality in my flat"
- "how good is the air quality inside"
- "how good is the air quality indoors"
- "how good is the air quality inside my house"
- "how good is the air quality inside my home"
- "how good is the air quality in my house"
- "how good is the air quality in my home"
- "how good is the air quality in the house"
- "how good is the air quality inside my apartment"
- "how good is the air quality in my apartment"
- "how good is the air quality inside my flat"
- "how good is the air quality in my flat"
- "is the air okay inside"
- "is the air okay indoors"
- "is the air okay inside my house"
- "is the air okay inside my home"
- "is the air okay in my house"
- "is the air okay in my home"
- "is the air okay in the house"
- "is the air okay inside my apartment"
- "is the air okay in my apartment"
- "is the air okay inside my flat"
- "is the air okay in my flat"
- "is the air good inside"
- "is the air good indoors"
- "is the air good inside my house"
- "is the air good inside my home"
- "is the air good in my house"
- "is the air good in my home"
- "is the air good in the house"
- "is the air good inside my apartment"
- "is the air good in my apartment"
- "is the air good inside my flat"
- "is the air good in my flat"
- "check the air quality inside"
- "check the air quality indoors"
- "check the air quality inside my house"
- "check the air quality inside my home"
- "check the air quality in my house"
- "check the air quality in my home"
- "check the air quality in the house"
- "check the air quality inside my apartment"
- "check the air quality in my apartment"
- "check the air quality inside my flat"
- "check the air quality in my flat"
- "tell me the air quality inside"
- "tell me the air quality indoors"
- "tell me the air quality inside my house"
- "tell me the air quality inside my home"
- "tell me the air quality in my house"
- "tell me the air quality in my home"
- "tell me the air quality in the house"
- "tell me the air quality inside my apartment"
- "tell me the air quality in my apartment"
- "tell me the air quality inside my flat"
- "tell me the air quality in my flat"
- "tell me what the air quality is inside"
- "tell me what the air quality is indoors"
- "tell me what the air quality is inside my house"
- "tell me what the air quality is inside my home"
- "tell me what the air quality is in my house"
- "tell me what the air quality is in my home"
- "tell me what the air quality is in the house"
- "tell me what the air quality is inside my apartment"
- "tell me what the air quality is in my apartment"
- "tell me what the air quality is inside my flat"
- "tell me what the air quality is in my flat"
- "tell me what the air is like inside"
- "tell me what the air is like indoors"
- "tell me what the air is like inside my house"
- "tell me what the air is like inside my home"
- "tell me what the air is like in my house"
- "tell me what the air is like in my home"
- "tell me what the air is like in the house"
- "tell me what the air is like inside my apartment"
- "tell me what the air is like in my apartment"
- "tell me what the air is like inside my flat"
- "tell me what the air is like in my flat"
- "give me the air quality inside"
- "give me the air quality indoors"
- "give me the air quality inside my house"
- "give me the air quality inside my home"
- "give me the air quality in my house"
- "give me the air quality in my home"
- "give me the air quality in the house"
- "give me the air quality inside my apartment"
- "give me the air quality in my apartment"
- "give me the air quality inside my flat"
- "give me the air quality in my flat"
- "give me an air quality report inside"
- "give me an air quality report indoors"
- "give me an air quality report inside my house"
- "give me an air quality report inside my home"
- "give me an air quality report in my house"
- "give me an air quality report in my home"
- "give me an air quality report in the house"
- "give me an air quality report inside my apartment"
- "give me an air quality report in my apartment"
- "give me an air quality report inside my flat"
- "give me an air quality report in my flat"
- "can you check the air quality inside"
- "can you check the air quality indoors"
- "can you check the air quality inside my house"
- "can you check the air quality inside my home"
- "can you check the air quality in my house"
- "can you check the air quality in my home"
- "can you check the air quality in the house"
- "can you check the air quality inside my apartment"
- "can you check the air quality in my apartment"
- "can you check the air quality inside my flat"
- "can you check the air quality in my flat"
- "can you tell me what the air quality is inside"
- "can you tell me what the air quality is indoors"
- "can you tell me what the air quality is inside my house"
- "can you tell me what the air quality is inside my home"
- "can you tell me what the air quality is in my house"
- "can you tell me what the air quality is in my home"
- "can you tell me what the air quality is in the house"
- "can you tell me what the air quality is inside my apartment"
- "can you tell me what the air quality is in my apartment"
- "can you tell me what the air quality is inside my flat"
- "can you tell me what the air quality is in my flat"
- "please check the air quality inside"
- "please check the air quality indoors"
- "please check the air quality inside my house"
- "please check the air quality inside my home"
- "please check the air quality in my house"
- "please check the air quality in my home"
- "please check the air quality in the house"
- "please check the air quality inside my apartment"
- "please check the air quality in my apartment"
- "please check the air quality inside my flat"
- "please check the air quality in my flat"
- "current air quality inside"
- "current air quality indoors"
- "current air quality inside my house"
- "current air quality inside my home"
- "current air quality in my house"
- "current air quality in my home"
- "current air quality in the house"
- "current air quality inside my apartment"
- "current air quality in my apartment"
- "current air quality inside my flat"
- "current air quality in my flat"
- "what's the current air quality inside"
- "what's the current air quality indoors"
- "what's the current air quality inside my house"
- "what's the current air quality inside my home"
- "what's the current air quality in my house"
- "what's the current air quality in my home"
- "what's the current air quality in the house"
- "what's the current air quality inside my apartment"
- "what's the current air quality in my apartment"
- "what's the current air quality inside my flat"
- "what's the current air quality in my flat"
- "what the current air quality is inside"
- "what the current air quality is indoors"
- "what the current air quality is inside my house"
- "what the current air quality is inside my home"
- "what the current air quality is in my house"
- "what the current air quality is in my home"
- "what the current air quality is in the house"
- "what the current air quality is inside my apartment"
- "what the current air quality is in my apartment"
- "what the current air quality is inside my flat"
- "what the current air quality is in my flat"
- "what is the air quality right now inside"
- "what is the air quality right now indoors"
- "what is the air quality right now inside my house"
- "what is the air quality right now inside my home"
- "what is the air quality right now in my house"
- "what is the air quality right now in my home"
- "what is the air quality right now in the house"
- "what is the air quality right now inside my apartment"
- "what is the air quality right now in my apartment"
- "what is the air quality right now inside my flat"
- "what is the air quality right now in my flat"
- "what is the air quality today inside"
- "what is the air quality today indoors"
- "what is the air quality today inside my house"
- "what is the air quality today inside my home"
- "what is the air quality today in my house"
- "what is the air quality today in my home"
- "what is the air quality today in the house"
- "what is the air quality today inside my apartment"
- "what is the air quality today in my apartment"
- "what is the air quality today inside my flat"
- "what is the air quality today in my flat"
- "a. q. i. inside"
- "a. q. i. indoors"
- "a. q. i. inside my house"
- "a. q. i. inside my home"
- "a. q. i. in my house"
- "a. q. i. in my home"
- "a. q. i. in the house"
- "a. q. i. inside my apartment"
- "a. q. i. in my apartment"
- "a. q. i. inside my flat"
- "a. q. i. in my flat"
- "what's the a. q. i. inside"
- "what's the a. q. i. indoors"
- "what's the a. q. i. inside my house"
- "what's the a. q. i. inside my home"
- "what's the a. q. i. in my house"
- "what's the a. q. i. in my home"
- "what's the a. q. i. in the house"
- "what's the a. q. i. inside my apartment"
- "what's the a. q. i. in my apartment"
- "what's the a. q. i. inside my flat"
- "what's the a. q. i. in my flat"
- "what is the a. q. i. inside"
- "what is the a. q. i. indoors"
- "what is the a. q. i. inside my house"
- "what is the a. q. i. inside my home"
- "what is the a. q. i. in my house"
- "what is the a. q. i. in my home"
- "what is the a. q. i. in the house"
- "what is the a. q. i. inside my apartment"
- "what is the a. q. i. in my apartment"
- "what is the a. q. i. inside my flat"
- "what is the a. q. i. in my flat"
- "what the a. q. i. is inside"
- "what the a. q. i. is indoors"
- "what the a. q. i. is inside my house"
- "what the a. q. i. is inside my home"
- "what the a. q. i. is in my house"
- "what the a. q. i. is in my home"
- "what the a. q. i. is in the house"
- "what the a. q. i. is inside my apartment"
- "what the a. q. i. is in my apartment"
- "what the a. q. i. is inside my flat"
- "what the a. q. i. is in my flat"
- "tell me the a. q. i. inside"
- "tell me the a. q. i. indoors"
- "tell me the a. q. i. inside my house"
- "tell me the a. q. i. inside my home"
- "tell me the a. q. i. in my house"
- "tell me the a. q. i. in my home"
- "tell me the a. q. i. in the house"
- "tell me the a. q. i. inside my apartment"
- "tell me the a. q. i. in my apartment"
- "tell me the a. q. i. inside my flat"
- "tell me the a. q. i. in my flat"
- "check the a. q. i. inside"
- "check the a. q. i. indoors"
- "check the a. q. i. inside my house"
- "check the a. q. i. inside my home"
- "check the a. q. i. in my house"
- "check the a. q. i. in my home"
- "check the a. q. i. in the house"
- "check the a. q. i. inside my apartment"
- "check the a. q. i. in my apartment"
- "check the a. q. i. inside my flat"
- "check the a. q. i. in my flat"
- "current a. q. i. inside"
- "current a. q. i. indoors"
- "current a. q. i. inside my house"
- "current a. q. i. inside my home"
- "current a. q. i. in my house"
- "current a. q. i. in my home"
- "current a. q. i. in the house"
- "current a. q. i. inside my apartment"
- "current a. q. i. in my apartment"
- "current a. q. i. inside my flat"
- "current a. q. i. in my flat"
- "air quality index inside"
- "air quality index indoors"
- "air quality index inside my house"
- "air quality index inside my home"
- "air quality index in my house"
- "air quality index in my home"
- "air quality index in the house"
- "air quality index inside my apartment"
- "air quality index in my apartment"
- "air quality index inside my flat"
- "air quality index in my flat"
- "what is the air quality index inside"
- "what is the air quality index indoors"
- "what is the air quality index inside my house"
- "what is the air quality index inside my home"
- "what is the air quality index in my house"
- "what is the air quality index in my home"
- "what is the air quality index in the house"
- "what is the air quality index inside my apartment"
- "what is the air quality index in my apartment"
- "what is the air quality index inside my flat"
- "what is the air quality index in my flat"
- "what the air quality index is inside"
- "what the air quality index is indoors"
- "what the air quality index is inside my house"
- "what the air quality index is inside my home"
- "what the air quality index is in my house"
- "what the air quality index is in my home"
- "what the air quality index is in the house"
- "what the air quality index is inside my apartment"
- "what the air quality index is in my apartment"
- "what the air quality index is inside my flat"
- "what the air quality index is in my flat"
- "what's the indoor air quality"
- "what is the indoor air quality"
- "tell me the indoor air quality"
- "check the indoor air quality"
- "please check the indoor air quality"
- "what the indoor air quality is"
- "what's the inside air quality"
- "what is the inside air quality"
- "tell me the inside air quality"
- "check the inside air quality"
- "please check the inside air quality"
- "what the inside air quality is"
- "air quality from my indoor sensor"
- "what's the air quality from my indoor sensor"
- "what is the air quality from my indoor sensor"
- "tell me the air quality from my indoor sensor"
- "check the air quality from my indoor sensor"
- "please check the air quality from my indoor sensor"
- "what the air quality from my indoor sensor is"

<!-- generated: end -->
