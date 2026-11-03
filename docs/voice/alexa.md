# Alexa adapter (YA-14)

The Amazon Alexa adapter for the voice client: a custom skill that stays in the development stage on the household's
Amazon account, runs as an AWS Lambda function in the owner's own AWS account, and links each speaker to their own
YouTrack account. Parent: YA-10, packet `docs/architecture/YA-10.md`. Issue: YA-14.

Nothing described here has been deployed. Every live step in the runbook is **Owner operates**, and the owner is
asked before each one.

What the household can say to the skill, and what it says back, is in the [voice command guide](commands.md).

## What is in the tree

| File                                    | Does                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `src/voice/alexa/envelope.ts`           | Hand-written subset of Alexa's request and response JSON. No `ask-sdk`.  |
| `src/voice/alexa/request.ts`            | Envelope to `VoiceRequest`: gating, intents, slots, pinned speaker key.  |
| `src/voice/alexa/response.ts`           | `VoiceResponse` to Alexa JSON: SSML, pauses, rate, earcons, cut guard.   |
| `src/voice/alexa/handler.ts`            | `createHandler(deps)`: the Lambda handler, time zone, budget, failures.  |
| `src/voice/alexa/messages.ts`           | The few sentences the adapter says itself.                               |
| `src/voice/alexa/dynamo-store.ts`       | Versioned `UserStateStore` over DynamoDB conditional puts, with TTL.     |
| `src/voice/alexa/model.ts`              | Catalogue to interaction model; refuses a catalogue that breaks a rule.  |
| `src/voice/alexa/generate-model.ts`     | CLI: prints the model JSON for a catalogue file.                         |
| `src/voice/alexa/intent-names.ts`       | Canonical intent names to Alexa intent names and back.                   |
| `src/voice/alexa/config.ts`             | Config, the Lambda environment reader, Amazon limits with sources.       |
| `src/voice/alexa/log.ts`                | JSON-line levelled logger with credential redaction.                     |
| `src/voice/alexa/deploy/template.yaml`  | SAM template: Lambda, table, log group, least-privilege role, trigger.   |
| `src/voice/alexa/deploy/hello-entry.ts` | Hello-world Lambda entry: the Alexa+ check (step 7) and enrolment (6).   |
| `test/voice/alexa/**`                   | Offline tests: recorded-style envelopes, fake clock and fetch, fixtures. |

Checks (from the repository root):

```sh
node --test 'test/voice/alexa/**/*.test.ts'
npx tsc -p test/voice/alexa/tsconfig.json
npx prettier --check src/voice/alexa test/voice/alexa docs/voice/alexa.md
cfn-lint --regions us-east-1 eu-west-1 us-west-2 -- src/voice/alexa/deploy/template.yaml
node src/voice/alexa/generate-model.ts test/voice/alexa/fixtures/catalogue.ts --invocation-name "my tracker" > /dev/null
```

`node --test test/voice/alexa/` (a directory) does not run the tests on Node 26: the runner treats the directory as a
module path and fails with `Cannot find module`. Use the quoted glob.

## Who may hear what (Owner decision OD1: household-wide reads)

The owner decided OD1 on 2026-09-12: "Assume everybody in the household has rights to access this skill." This
household therefore deploys **option B for reads**, and the step 2.3 command sets it:

- Reads accept `person` or `account` evidence (`ReadAccepts=person,account`), and a speaker with no person-level link
  reads through the Amazon account's own link (`AccountTokenFallback=true`). That means anyone using an Alexa device or
  the Alexa app signed in to this Amazon account can hear what the account-level link can read. That includes the Echo
  in the room, other Echos, Fire TV or a car signed in to it, and the Alexa app on any phone signed in to it, wherever
  that phone is, including visitors and anyone nearby.
- **Two YouTrack accounts, two links.** The account-level link holds the **dedicated household YouTrack account**: a
  separate account, created in step 1.1, with read access to only what the whole household may hear. The enrolled
  person's own YouTrack account is linked separately, at profile level (step 8.3), and is the only one that can write.
- Writes still accept `person` only (`WriteAccepts=person`): the enrolled voice with that person's own link. The
  function always refuses `account` in `WRITE_ACCEPTS`.
- Within one session, a turn never reads a list saved under another tracker identity (YA-21, "State key" below).

**The code default stays option A**, the stricter alternative, for any deploy that does not choose B on purpose:

- A request reaches the tracker only with the **recognised person's own profile-level token**. The Amazon account's
  own linked token is never used, for anyone.
- `person` evidence needs both: the voice is the enrolled person (`ENROLLED_PERSON_ID`) and the token is that
  person's own. Reads and writes accept `person` only.
- An unrecognised voice hears "I do not recognise your voice for this skill." and nothing else: no card, no core, no
  tracker, no state. A recognised voice with no link of its own is asked to link.

Option B needs **both** `AccountTokenFallback=true` and `ReadAccepts=person,account`; the function refuses to start
with `account` in `READ_ACCEPTS` and the fallback off. The effective policy is logged once per cold start
(`alexa.config`).

**Cards (OD2, pending)** are off by default: nothing but speech leaves the room. `Cards=on` sends Simple cards,
which show issue text on screen devices and in the Amazon account holder's Alexa app history. LinkAccount cards are
sent either way.

## How a request is handled

1. **Check the skill.** Every application id in the envelope (`context.System.application` and
   `session.application`) must be `SKILL_ID`, whatever the request type; otherwise the handler throws, so Lambda
   reports an error and nothing is spoken. The Lambda permission is also restricted to the skill id, so this check is
   the second guard. Request types other than launch, intent and session-ended then get an empty response.
2. **Map and gate.** See "Mapping rules". With no usable token, a recognised voice gets the linking prompt and a
   LinkAccount card; an unrecognised one is refused. Neither makes a tracker, calls the core or touches the store.
3. **Look up the time zone** once per session: `GET {apiEndpoint}/v2/devices/{deviceId}/settings/System.timeZone`
   with the request's `apiAccessToken`, which needs no customer permission. The lookup has a hard 300 ms limit. The
   result (or `null` after a failure, which is logged at info and not retried) is carried in `sessionAttributes`.
   Without it the core speaks absolute dates.
4. **Run one core turn against the budget.** The deadline counts from Amazon's request timestamp when that is up to a
   minute old (cold start and network time count against the budget), otherwise from arrival. A request that arrives
   already past 7 s gets the honest answer at once.
   - At 5 s with no answer, one progressive response ("One moment.") is sent to `POST {apiEndpoint}/v1/directives`,
     only when `apiEndpoint` is HTTPS on an Alexa API host, never following a redirect, and aborted after 1 s. The full
     answer waits for an in-flight progressive response for at most 300 ms, and never past the deadline.
   - At 7 s with no answer, the speaker hears that the tracker is taking too long, and the session stays open. The
     turn's `AbortSignal` fires; from then on the turn's tracker calls and saves are refused
     (`alexa.turn.lateEffectRefused`), whatever the core does with the signal. Saves are also conditional on the
     version the turn loaded, so a late save can never erase a newer one.
5. **Render or explain.** The core's response is rendered. A failure is classified and spoken without its detail:
   - 401 means the link expired or was revoked, so the speaker is asked to relink and gets a LinkAccount card.
   - 408, 429, 5xx, AWS throttling and network errors mean the tracker is not answering.
   - Anything else is "something went wrong on my side".

Session-ended requests still run a core turn when a usable token is present, so state is saved, and they return an
empty response.

### Mapping rules

- **Built-ins.** `AMAZON.HelpIntent` maps to help, and StopIntent, CancelIntent, RepeatIntent and PreviousIntent to
  stop, cancel, repeat and previous. `AMAZON.NextIntent` maps to more, YesIntent to confirm and NoIntent to deny.
  `AMAZON.NavigateHomeIntent` is emitted for screen devices, but Alexa handles it and ends the session without sending
  it to the skill; if one ever arrives it maps to stop.
- **Unrecognised speech.** `AMAZON.FallbackIntent`, and any intent name the skill never defined, becomes
  `{kind: 'utterance', text: ''}`. Alexa sends neither the words nor a confidence.
- **Custom intents** are named `<Name>Intent`, for example `openById` becomes `OpenByIdIntent`.
- **Slots.** An `ER_SUCCESS_MATCH` resolution's value `id` (the catalogue's enum value) wins over the heard value; on
  no match the heard value is kept. Unfilled slots are absent keys. AMAZON.NUMBER's `?` counts as no value. An ordinal
  slot has a companion `<name>_ordinal` (AMAZON.Ordinal), which fills the base slot only when that is empty.
- **Token.** `person.accessToken` when present. `context.System.user.accessToken` (then `session.user.accessToken`)
  only with `ACCOUNT_TOKEN_FALLBACK=true`.
- **Evidence.** `['person']` only when `context.System.person.personId` equals `ENROLLED_PERSON_ID` **and** the token
  is that person's own. Otherwise `['account']`.
- **State key.** One record per voice and link: `alexa:person:<personId>` for a recognised voice on its own link,
  `alexa:user:<userId>` for an unrecognised voice on the account link, and `alexa:person:<personId>:account` for a
  recognised voice reading through the account link, so one person's lists through two links never mix.
- **Tracker identity** (YA-21). Each turn's token speaks for one YouTrack account, named without a tracker call by the
  kind of link and a hash of the Alexa id holding it: `person:<hash of personId>` or `account:<hash of userId>`. A
  holder has one link, so this stays stable when Alexa refreshes the token, which a hash of the token would not.
  Relinking a holder to a different YouTrack account is not detected: YA-15 logs the bound login and holds the
  account-level link to `HOUSEHOLD_LOGIN`, but the tracker identity does not include the login. That is YA-28.
- **Session pin.** Each response pins `{key, identity}` of the record it used in `sessionAttributes.speaker`: the list
  the listener just heard. Amazon decides recognition per request, so the next turn of the session:
  - with the **same** tracker identity uses the pinned record (Voice ID misses on "open two" after a list read through
    the same link);
  - with a **different** identity starts fresh, on a record for this session only
    (`<own key>:session:<hash of sessionId>`). It never reads the pinned record, and never its own older record,
    which the listener did not just hear: the core says there is no list, and "my issues" starts one. In both
    directions: an unrecognised follow-up after the enrolled person's own-link list, and the enrolled person's
    recognised follow-up after an account-link list.

  Pinning never changes evidence. Under option A an unrecognised turn never reaches the core. A fresh record starts
  with the core's default preferences for that session (a known cost, noted under Open questions).

- **Capabilities.** SSML, earcons and follow-up are always on. A display is detected from `Viewport` or a `Display`
  or `Alexa.Presentation.APL` key in `supportedInterfaces` (a map, not an array). `maxSpeechChars` is **4000**: the
  plain characters the adapter can deliver whole in one response, with headroom for escaping (which can double
  code-shaped text) and markup, as contract revision 1 defines it.

### Rendering rules

- **Escaping.** `& < > " '` are escaped. Control characters XML cannot carry and lone UTF-16 surrogates are removed.
  Text that looks like SSML is spoken, never interpreted.
- **Cut guard.** If the SSML would pass Amazon's 8000 characters anyway, the segment that does not fit is cut at a
  word boundary (else after a sentence end, else without splitting a character or an entity), "I had to stop there."
  is spoken, and nothing after it is. The response is never silent when the core gave text, and a warning
  (`alexa.response.cut`) is logged. The adapter never pages, rewords or splits speech across responses.
- **Pauses.** A short pause is a 350 ms `<break>`, a long pause 900 ms. There is no break after the last segment. An
  unknown pause or earcon renders nothing.
- **Rate.** `ratePercent` is rounded and clamped to 20..200. It becomes `<prosody rate="N%">` around the speech, and is
  left out at 100.
- **Earcons.** Success and failure play before the speech. End of list and listening play after it.

  | Earcon    | Sound Library path                                      | Length |
  | --------- | ------------------------------------------------------- | ------ |
  | success   | `musical/amzn_sfx_bell_short_chime_01`                  | 0.71 s |
  | failure   | `ui/gameshow/amzn_ui_sfx_gameshow_negative_response_01` | 0.58 s |
  | endOfList | `alarms/beeps_and_bloops/tone_03`                       | 0.81 s |
  | listening | `alarms/beeps_and_bloops/bell_01`                       | 0.57 s |

  All are under a second, a first choice to change after the household hears them.

- **Session.** `shouldEndSession` is `!listen`. The reprompt is rendered only when listening. If the core forgot one,
  a generic reprompt is used and a warning logged.
- **Cards.** A Simple card is sent only with `CARDS=on` and a screen. Its title and text are cut to Amazon's
  8000-character card limit on a whole character; the card repeats the speech, so nothing is lost.

### State

`dynamo-store.ts` keeps one item per state key: `state` (the core's opaque string), a numeric `version`, `updatedAt`
(ms) and `expiresAt` (TTL, seconds). A first save is conditional on nothing usable being stored (no item, no version,
or an expired item DynamoDB has not deleted yet); every later save is conditional on `version` still being the one
the turn loaded. A failed condition returns `false` (the core keeps the other turn's state and logs it); any other
DynamoDB error propagates.

### Logging

Every line is JSON, and every line of a request carries Lambda's `awsRequestId`. At `info` the adapter logs:

- the effective policy once per cold start (`alexa.config`, no ids);
- request type, intent, slot names, evidence, whether a person was present and matched, which link the token came
  from (`linkedVia`), and whether the speaker key was pinned;
- a 12-hex-character SHA-256 tag of the state key, never the id itself;
- for a session end, Amazon's `reason` and error `type` (such as `INVALID_RESPONSE`);
- refusals, timings, response shape, cuts, time-zone lookups and progressive-response status;
- for a failure, its kind, error name, numeric `status` and a short `errorCode`, never its message.

At `debug` only: raw userId and personId, slot values, the time zone, the rendered SSML, Amazon's session-end error
message, and error messages, with the request's own tokens and anything shaped like a bearer token redacted first.
Tokens are never passed to the logger, and the logger also blanks any field named like a token, secret,
authorization, password or credential. Tests drive full requests at debug through the real logger, in both policy
modes, and assert that no token appears. The raw event is never logged by either entry: it holds three credentials.

`ENROLMENT_LOG=true` adds one info line per recognised request, `alexa.enrolment.person {requestId, personId}`, for
runbook step 6 only.

### Interaction model generation

For the household's three supported English locales, use the complete generated files and build checklist in
[`models/README.md`](../../models/README.md) (YA-37). One command writes all three:

```sh
node src/voice/alexa/generate-model.ts src/voice/core/intents.ts --invocation-name "issue desk" --all-locales --output-dir models
```

Add `--check` for a read-only drift check. For single-file stdout output, `--locale en-US`, `--locale en-GB`, or
`--locale en-CA` selects regional vocabulary; omitted means **en-US**. Upload/build each file under its matching
locale in Amazon's console. Deploying Lambda does not update the interaction model.

```sh
node src/voice/alexa/generate-model.ts src/voice/core/intents.ts --invocation-name "my tracker" > model.json
```

- **Slot types.**
  - `ordinal`: AMAZON.NUMBER, plus an AMAZON.Ordinal companion slot, with every sample emitted once for each.
  - `enum`: a custom type named `<Slot>Values`, whose value `id` is the catalogue value and whose name is the spoken
    form (`in-progress` is said "in progress"). Same-named slots with different values get the intent prefixed.
  - `phrase`: AMAZON.SearchQuery. The list intent's `person` slot (YA-35, "what's assigned to Chris") is one too.
    AMAZON.FirstName was ruled out: Amazon describes it as "thousands of popular first names", sent as spoken with no
    nickname conversion, so a full name ("Chris Coulter") or "the household" would not be heard whole. A custom slot
    type is biased to the values it lists, and the household's people change with the tracker, so its list would go
    stale. SearchQuery hands the core the words as said, and the core matches them against the tracker's own people.
    Checked 2026-09-13 against the slot type reference and the sample utterance rules (both linked under Sources).
    The air-quality intent's `place` slot (YA-36) is one as well, for towns, postal codes and sensor names alike; see
    "Air quality (YA-36)".
  - A possessive phrase slot is written `{person}'s issues` in the catalogue, so the text grammar requires the "'s",
    and emitted as `{person} issues`, as Amazon asks ("Use `tell me a {Drink} ingredients` ... Don't use
    `tell me a {Drink}'s ingredients`"). The spoken value then arrives as "chris's", and the core drops the "'s". A name
    Alexa files in the scope slot instead (`{scope} issues`, no entity-resolution match) is heard as the person.
  - `spelled`: **AMAZON.AlphaNumeric** (public beta). Amazon documents it as converting "letters, numbers, hyphens,
    and periods into alphanumeric sequences", with the example "w. q. p. four five nine" becoming `wqp459`, and it is
    available in every locale except Arabic (SA) and Dutch (NL). SearchQuery would hand back words ("why ay one
    four") and allows only one slot with a carrier phrase. A custom slot type cannot hold open-ended sequences.
    Unconfirmed: whether AlphaNumeric turns phonetic-alphabet words ("yankee alpha") into letters. The core's
    `openById` should accept compact values like `ya14` either way, and a live check is part of step 8.
- **Built-ins.** Catalogue intents with a built-in equivalent extend that built-in with the catalogue's samples, which
  Amazon allows. Help, Stop, Cancel, NavigateHome and Fallback are always emitted.
- **Refusal rules.** Generation refuses, listing every problem and exiting 1, when:
  - a sample holding a `phrase` slot holds another slot, has no carrier words, or the intent has two `phrase` slots;
  - a slot other than a `phrase` slot is possessive (`{part}'s`);
  - a sample contains digits or punctuation other than apostrophes, periods and hyphens;
  - a sample repeats, within an intent or across intents;
  - a sample uses an undeclared slot, or a declared slot is never used;
  - a slot name is not letters only (the underscore is reserved for companion slots);
  - an enum has no values, values that are not lower-case words, or two values said the same way
    (`in-progress` and `in progress`);
  - a built-in-mapped intent has slots;
  - the invocation name is missing (the placeholder is refused) or breaks Amazon's English rules: at least two words;
    lower-case letters, possessive apostrophes and single letters with periods (`n. p. r.`); no wake word (alexa,
    amazon, echo, computer), "skill" or "app"; no launch word (run, start, play, resume, use, launch, ask, open, tell,
    load, begin, enable) or connecting word (to, from, in, using, with, about, for, that, by, if, and, whether); and
    no two-word name with an article or short preposition.

## Runbook

**Who** is either the Owner, or the household member (the user). **Sight** says whether the step needs a screen: yes,
no, or "screen reader" where a screen reader user can do it but a sighted helper will be faster. The sighted steps
happen once. Nothing in daily use needs sight.

**Order.** Step 7, the hello-world check, is done **first** in practice: right after steps 2 and 3, before any effort
goes into linking. Custom skills on Alexa+ are unconfirmed (YA-10, Risks), and the hello entry needs no tracker,
core or linking. Steps 2 and 3 interleave, because the stack needs the skill id and the skill needs the function ARN.

### 1. Create the YouTrack OAuth client

**Who:** Owner, as YouTrack administrator. **Sight:** yes (web admin), once.

1. **Create the two YouTrack accounts the skill links.** A voice token carries that account's full API rights, even
   while the skill only reads, and "access granted through an OAuth client never exceeds the permissions of the user
   who authorizes". Never link the Owner's or an administrator's account.
   - **The dedicated household account** (option B's account-level link, used by every voice that is not the
     enrolled person). In Administration > Access Management > Users, create a new user, for example `household`,
     that belongs to no person. Give it access to **project H (Household) only**, with a **read-only** role that can
     read issues and comments and nothing more (no create, update, comment or admin permissions). Check the role's
     permission list in your instance. Add it to the **Household Team** group, and assign it the issues "my issues"
     should read. Its login is the stack's `HouseholdLogin`. Nobody signs in to it day to day; keep its password with
     the Owner.
   - **The household member's own account** (the profile-level link, step 8.3), with only the projects they need.
     It is a separate account and a separate link, made in a separate step.
2. Go to Administration > Access Management > OAuth Clients > **New OAuth client** (YouTrack 2026.2 or later). Name it
   "Alexa voice client".
3. On the Authentication tab:
   - Turn on the **Authorization Code flow**.
   - Turn on **Require PKCE**. Alexa supports PKCE with SHA-256, and PKCE must also be turned on in step 4.
   - Turn on the user consent requirement, so the household member sees what they are granting.
4. **Redirect URIs:** the Alexa Redirect URLs shown on the skill's account-linking page (step 4). There are three, one
   per region: `https://pitangui.amazon.com/api/skill/link/<vendor id>`,
   `https://layla.amazon.com/api/skill/link/<vendor id>` and `https://alexa.amazon.co.jp/api/skill/link/<vendor id>`.
   Register all three.
5. Save, then copy the **Client ID** and the **Client secret**. The secret goes into the Alexa console (step 4) and
   nowhere else: not the repository, not the Lambda environment, not a tracker comment.
6. Note the values for step 4. These are the values saved for this household's client (checked by the Director,
   2026-09-13):
   - Client id: `alexa-voice-client`, a confidential client (it has a secret).
   - Authorization: `https://example.youtrack.cloud/hub/api/rest/oauth2/auth`
   - Token: `https://example.youtrack.cloud/hub/api/rest/oauth2/token`, with HTTP Basic client authentication.
   - Scopes: `<YouTrack service id>` (the YouTrack service id) and `offline_access`.
   - PKCE: on, method S256.
   - Refresh tokens: Hub issues them only with `access_type=offline` (and the `offline_access` scope).
   - A fresh login: Hub's `request_credentials=required` "logs out user and shows login form", so a browser already
     signed in to YouTrack as someone else cannot authorise that someone.
   - Alexa builds the authorization request itself, so both go on the Web Authorization URI in step 4:
     `?access_type=offline&request_credentials=required`. **To verify on the first link** (step 8.3a): that Alexa keeps
     a query string already on that URI, that the login form appears, and that a refresh token is issued (step 8.5).
     Keep `request_credentials=required` whatever else changes: it is what stops a browser signed in as the Owner
     from linking the Owner's account.

### 2. Deploy the stack

**Who:** Owner operates, asked first. **Sight:** screen reader (terminal and AWS login). Needs the skill id from
step 3.1.

1. **Region.** Choose the region for the household's Alexa region: North America `us-east-1`, Europe and India
   `eu-west-1`, Far East `us-west-2`.
2. **Build** from a clean tree into `src/voice/alexa/deploy/.build/lambda`, which is git-ignored. `npm ci` installs the
   locked TypeScript (5.9.3) rather than whatever satisfies the range. The command was checked locally: it emits
   ES2022 JavaScript, and the hello entry answered a fixture launch.

   ```sh
   npm ci
   rm -rf src/voice/alexa/deploy/.build
   npx tsc src/voice/alexa/deploy/hello-entry.ts --outDir src/voice/alexa/deploy/.build/lambda --rootDir src \
     --module nodenext --moduleResolution nodenext --target es2022 --rewriteRelativeImportExtensions \
     --verbatimModuleSyntax --skipLibCheck --types node
   echo '{"type":"module"}' > src/voice/alexa/deploy/.build/lambda/package.json
   ```

   The full entry, `deploy/lambda-entry.ts` (YA-15), is built the same way, naming that file and adding `--strict`
   (the core narrows its result types, which the compiler only does under strict checks). It was checked locally: the
   compiled entry answered a fixture launch and a "my issues" turn with a fake DynamoDB and a fake tracker injected.

   ```sh
   rm -rf src/voice/alexa/deploy/.build
   npx tsc src/voice/alexa/deploy/lambda-entry.ts --outDir src/voice/alexa/deploy/.build/lambda --rootDir src \
     --module nodenext --moduleResolution nodenext --target es2022 --rewriteRelativeImportExtensions \
     --verbatimModuleSyntax --strict --skipLibCheck --types node
   echo '{"type":"module"}' > src/voice/alexa/deploy/.build/lambda/package.json
   ```

   It imports `@aws-sdk/client-dynamodb` from the Lambda runtime at its first invocation, so nothing is bundled.
   **To verify** on the first full deploy: the `alexa.entry.ready` info line appears, not `alexa.entry.startFailed`.

3. **Deploy.** Every deploy uses this one command and passes **every** parameter explicitly, because CloudFormation
   otherwise keeps the previous value of any parameter left out (a debug log level, the hello entry, a policy).
   `--on-failure DELETE` makes a failed **first** create delete itself, so the command can simply be run again.

   ```sh
   sam deploy --template-file src/voice/alexa/deploy/template.yaml --stack-name youtrack-voice \
     --region <region> --capabilities CAPABILITY_IAM --resolve-s3 --no-fail-on-empty-changeset --on-failure DELETE \
     --parameter-overrides SkillId=<skill id> EntryHandler=voice/alexa/deploy/hello-entry.handler \
       'EnrolledPersonId="<person id, or nothing>"' ReadAccepts=person,account WriteAccepts=person \
       AccountTokenFallback=true Cards=off EnrolmentLog=false LogLevel=info
   ```

   **Read access is household-wide.** The owner chose it, and Alexa cannot tell household members from visitors: anyone
   using an Alexa device or the Alexa app signed in to this Amazon account can hear what the account-level link can
   read. That includes the Echo in the room, other Echos, Fire TV or a car signed in to it, and the Alexa app on any
   phone signed in to it, wherever that phone is, including visitors and anyone nearby. So the account-level link must
   be the **dedicated household YouTrack account** (step 1.1), with access to only what the whole household should hear.
   Never link an account with more.

   **The stricter alternative (option A):** `ReadAccepts=person AccountTokenFallback=false`. Only the enrolled voice
   with its own link reads, and everyone else is refused.

   Named variants used before step 8, each **the hello-entry command above** with only these values changed:
   - **Enrolment on** (step 6): `EnrolmentLog=true`, everything else as now.
   - **Enrolment off** (step 6): `EnrolmentLog=false EnrolledPersonId=<the id>`.

   **The full-entry command** (step 8 onwards), built with the full-entry command in 2.2. From here on it replaces the
   hello-entry command: every later deploy is this command, so a variant can never put the hello entry back.

   ```sh
   sam deploy --template-file src/voice/alexa/deploy/template.yaml --stack-name youtrack-voice \
     --region <region> --capabilities CAPABILITY_IAM --resolve-s3 --no-fail-on-empty-changeset --on-failure DELETE \
     --parameter-overrides SkillId=<skill id> EntryHandler=voice/alexa/deploy/lambda-entry.handler \
       'EnrolledPersonId="<person id, or nothing>"' ReadAccepts=person,account WriteAccepts=person \
       AccountTokenFallback=true Cards=off EnrolmentLog=false LogLevel=info \
       YouTrackBaseUrl=https://example.youtrack.cloud YouTrackProject=H HouseholdLogin=<household login> \
       StateTtlDays=90 LogRetentionDays=30
   ```

   Every voice query is scoped to project **H** (Household), and the dedicated household account must have
   read-only access to H only. `HouseholdLogin` is that account's login (step 1.1): an account-level link to any other
   YouTrack account hears "your tracker account link has expired or was removed" and reads nothing, and the function
   refuses to start without it while `AccountTokenFallback=true`. The URL, project and login are the function's
   `YOUTRACK_URL`, `YOUTRACK_PROJECT` and `HOUSEHOLD_LOGIN`; no token is ever a parameter.

   Named variants after step 8, each **the full-entry command** with only these values changed:
   - **Debug on**, for a short diagnosis only: `LogLevel=debug`. **Debug off**: `LogLevel=info`. Debug lines carry
     speech, slot values, Amazon ids and the bound YouTrack login, and cost more to store.
   - **Option A**: `ReadAccepts=person AccountTokenFallback=false` (then `HouseholdLogin` may be empty).

   The template has not been through `sam validate`. It passes `cfn-lint` 1.56.3 for us-east-1, eu-west-1 and
   us-west-2. **An empty `EnrolledPersonId`** is written `'EnrolledPersonId=""'`, single quotes included, so the double
   quotes reach SAM. SAM CLI 1.166.2 refuses `EnrolledPersonId=`, and inside `--parameter-overrides` it reads
   `ParameterKey=EnrolledPersonId,ParameterValue=` as a different key, leaving the value unset. A parameter left out
   keeps its live value (YA-33, finding 13).

4. **Check what is live**, after every deploy:

   ```sh
   aws lambda get-function-configuration --function-name youtrack-voice-alexa --region <region> \
     --query '{h:Handler,l:Environment.Variables.LOG_LEVEL,f:Environment.Variables.ACCOUNT_TOKEN_FALLBACK,e:Environment.Variables.ENROLMENT_LOG,r:Environment.Variables.READ_ACCEPTS,u:Environment.Variables.YOUTRACK_URL,p:Environment.Variables.YOUTRACK_PROJECT,hl:Environment.Variables.HOUSEHOLD_LOGIN}'
   ```

5. Copy the `FunctionArn` output of the deploy.

What it creates:

- a Node.js 24 arm64 function, with an 8 s timeout, invokable only by `alexa-appkit.amazon.com` with
  `EventSourceToken` set to the skill id;
- an on-demand DynamoDB table keyed on `userId`, with TTL on `expiresAt`;
- a log group with 30-day retention;
- a role allowed only `logs:CreateLogStream` and `logs:PutLogEvents` on that group, and `dynamodb:GetItem` and
  `dynamodb:PutItem` on that table (conditional puts need nothing more).

`--resolve-s3` also creates SAM's own `aws-sam-cli-managed-default` stack and artifact bucket, once per region.

### 3. Create the skill in the developer console, development stage

**Who:** Owner, signed in with the Amazon account that the household's Echo uses. **Sight:** yes, once.

1. In the [Alexa developer console](https://developer.amazon.com/alexa/console/ask), click **Create Skill**:
   - Choose a name, and the primary locale of the household's device (for example English (UK)).
   - Choose the **Custom** model and **Provision your own** hosting, and start from scratch.
   - Copy the **skill id** and go to step 2.
2. **Interaction model.** Open Build > Interaction Model > JSON Editor, and paste the output of
   `generate-model.ts --invocation-name "<name>"`. The generator refuses a name Amazon would refuse; pick one that is
   easy for the household member to say. Save, then Build Model. Until integration, the fixture catalogue's model is
   enough for the hello-world check.
3. **Endpoint.** Choose AWS Lambda ARN, and paste `FunctionArn` as the default region.
4. **Test.** On the Test tab, set skill testing to **Development**. A development-stage skill works on Echo devices
   signed in to the same developer account, with no certification.

### 4. Set up account linking

**For this household, see [Linking without the Alexa app (YA-33)](#linking-without-the-alexa-app-ya-33).** The Alexa iOS
app could not link with the settings below, so there the broker's URIs and credentials replace them.

**Who:** Owner. **Sight:** yes, once.

1. In Build > Tools > **Account linking**, turn linking on. Also turn on **Allow users to enable skill without
   account linking**: the skill then asks to link by voice, and the hello-world check works before linking.
2. Set:
   - Authorization grant type: **Auth Code Grant**.
   - Web Authorization URI:
     `https://example.youtrack.cloud/hub/api/rest/oauth2/auth?access_type=offline&request_credentials=required`.
   - Access Token URI: `https://example.youtrack.cloud/hub/api/rest/oauth2/token`.
   - Client ID: `alexa-voice-client`. Client Secret: from step 1.5.
   - Authentication scheme: **HTTP Basic**.
   - Scopes: `<YouTrack service id>` and `offline_access` (two entries). Without `offline_access` no
     refresh token is issued, and the link dies when the first access token expires.
   - Domain list: `example.youtrack.cloud`.
   - PKCE: **on**, S256.
   - Default access token expiration: leave empty, so YouTrack's `expires_in` is used.
3. Copy the three **Alexa Redirect URLs** from this page into the OAuth client (step 1.4), and save both.

### 5. The personalization permission and the privacy policy

**Who:** Owner. **Sight:** yes, once.

1. In Build > **Permissions**, turn on **Skill Personalization** (scope `alexa::person_id:read`). Without it, requests
   carry no `person` object, and in the default policy the skill then refuses everyone. The time-zone lookup needs no
   permission.
2. Amazon requires a privacy policy URL for skills that use personalization. Add one in Distribution > Privacy &
   Compliance. For personal use, a short page is enough. It should say:
   - Per-person state is stored in DynamoDB, in the owner's AWS account: the current list of issues, the position in
     it, preferences, and **the last response read aloud**, which can include issue summaries and text. It is deleted
     90 days after last use.
   - Logs carry no speech or issue content at the normal level, and are kept 30 days. A short enrolment window (step 6)
     logs the Alexa person id.
   - Tokens are held by Amazon and passed to the function per request, never stored by it.
   - If cards are turned on, issue text is shown on screen devices and in the Amazon account's Alexa app history.
   - Unlinking in the Alexa app and deleting the token in YouTrack ends access.

### 6. Enrol the voice ID, turn on "Personalize skills", and record the person id

**Who:** the household member with the Owner. **Sight:** screen reader (Alexa app), and the Owner reads a log line.
Works with the hello entry; no linking and no debug logging are needed.

1. The household member creates a **voice ID** in the Alexa app, and **Personalize skills** is turned on for them.
   Amazon documents both as Alexa app settings. Their exact menu path was not checked here: follow Amazon's "Manage
   skill personalization as a user" help.
2. The Owner deploys the **Enrolment on** variant (asked first).
3. The household member says "Alexa, open <invocation name>".
4. The Owner reads the id from the `alexa.enrolment.person` line, for example with
   `aws logs tail /aws/lambda/youtrack-voice-alexa --since 10m --region <region> | grep alexa.enrolment.person`. The
   id differs for each skill and for each Amazon account, so it can only be read this way.
5. The Owner deploys the **Enrolment off** variant with `EnrolledPersonId=<that id>` (asked first), then checks with
   the step 2.4 command that `ENROLMENT_LOG` is `false`.
6. The enrolment lines stay in the log group for `LogRetentionDays` (30). To remove them sooner, list the streams
   written during the window with `aws logs describe-log-streams --log-group-name /aws/lambda/youtrack-voice-alexa
--order-by LastEventTime --descending --region <region>`, and delete each with `aws logs delete-log-stream
--log-group-name /aws/lambda/youtrack-voice-alexa --log-stream-name <name> --region <region>`.

### 7. FIRST: the hello-world check on the household's own device

**Who:** the household member speaks, the Owner watches the logs. **Sight:** console Test tab yes, the rest no. Do this
right after steps 2 and 3, with the hello entry.

1. The Owner starts following the logs: `aws logs tail /aws/lambda/youtrack-voice-alexa --follow --region <region>`.
2. **First, without the Echo:** in the developer console's Test tab, type "open <invocation name>". This separates
   "the skill and the Lambda work" from "this device routes to them". A fault here is ours, not Alexa+'s.
3. Then the household member says "Alexa, open <invocation name>" on the household's own Echo.
4. **Pass:** a short chime, then "Hello. Your tracker skill is reaching its own code, so custom skills work on this
   device." The log shows `alexa.hello.invoked` then `alexa.hello.request`.
5. **Read a failure by what the log shows for that attempt:**
   - **No `START` line at all**, and the Test tab worked: the device did not route to the skill, which is the Alexa+
     risk. Record it on YA-14 and YA-10; the adapter choice goes back to the Owner (YA-16 telephony is next).
   - **`START` with `ERROR`**, or any of `alexa.hello.config.invalid`, `alexa.hello.envelope.invalid` or
     `alexa.hello.application.rejected`: our bug or configuration. Record the lines on YA-14, and do **not** escalate
     it as an Alexa+ failure.
   - **`alexa.hello.request`, then `alexa.hello.sessionEnded` with an `errorType`**: Alexa rejected our response.
     Record the `errorType` on YA-14.

### 8. Try it

**Who:** the household member, with the Owner verifying. **Sight:** screen reader, for the one-time link in the Alexa
app. Done after integration, when the full entry is deployed with **the full-entry command** (step 2.3).

1. **Option B only: link the account level first, as the dedicated household account.** This is its own step, and it is
   not the household member's link. From a session where nobody is recognised (for example the Owner in the Alexa app's
   skill page, with no voice ID in use), choose link, sign in to YouTrack as the **household** account (step 1.1) with a
   fresh login, and approve. Amazon does not document how an account-level link is made once personalization is on: **to
   verify** with check 3a.3. From then on, anyone using an Alexa device or the Alexa app signed in to this Amazon
   account can hear what the account-level link can read. That includes the Echo in the room, other Echos, Fire TV or a
   car signed in to it, and the Alexa app on any phone signed in to it, wherever that phone is, including visitors and
   anyone nearby.
2. The household member, while recognised, says "Alexa, open <invocation name>." The skill says their account is not
   linked yet and sends a link card.
3. **Link at profile level, as the household member, with a fresh login.** Before linking, sign out of YouTrack in
   the phone's browser, or use a private window. Link from the household member's own Alexa voice-profile session,
   while they are recognised, so the link is profile level. In the Alexa app, open the card or the skill's page and
   choose link. The YouTrack login form must appear: sign in as the household member (never the Owner), and approve.

   **3a. Check what was linked (mandatory, before step 4).**
   1. The household member speaks to the skill. The `alexa.request` info line shows `linkedVia: "person"` and
      `personMatched: true`.
   2. In YouTrack, the new token is listed under the **household member's** profile > Account Security, and not under
      the Owner's.
   3. A second, unenrolled voice says "Alexa, open <invocation name>". Under option B, its `alexa.request` line shows
      `linkedVia: "account"`, and in YouTrack that token is listed under the **household account**, never the Owner's.
      Under option A it hears "I do not recognise your voice for this skill", not tracker content.
   4. Match each link to its login. The first turn for each token writes `voice.binding.linked` at info with
      `requestId`, `linkedVia` and `loginTag`; the account-level line also has `householdLogin: "match"`. Match the
      `requestId` to the `alexa.request` line of the same turn, and compare each `loginTag` with
      `node -e "console.log(require('node:crypto').createHash('sha256').update('<login>').digest('hex').slice(0, 12))"`.
      A `voice.binding.loginMismatch` warning means the account-level link is some other account: that voice heard
      "link has expired or was removed" and nothing else. Relink it as the household account.
   5. `voice.binding.callFailed` with `kind: "validation"` or `status: 400` on a list means the query was refused, not
      that YouTrack is down: check the household account's access to H.

   If any check fails: unlink in the Alexa app, delete the token in YouTrack, **delete that holder's saved state**
   (below), and link again. The skill still cannot tell that a holder was relinked to a different YouTrack account
   (YA-15 logs the login, and refuses a wrong account-level login, but does not separate saved records by login; that
   is YA-28): without this, the old account's last list and last reply stay in the holder's records and could be read
   out once under the new link.

   **Delete a holder's saved state** (Owner operates, with the Owner's AWS credentials; the function's role cannot
   scan). First find the table:

   ```sh
   TABLE=$(aws cloudformation describe-stacks --stack-name youtrack-voice --region <region> \
     --query "Stacks[0].Outputs[?OutputKey=='StateTableName'].OutputValue" --output text)
   ```

   - **A person-level link was wrong:** delete that person's records (their own key, their `:account` and `:person`
     records and any session records). `<person id>` is the id from step 6.

     ```sh
     K='alexa:person:<person id>'
     aws dynamodb scan --table-name "$TABLE" --region <region> --projection-expression userId \
       --filter-expression 'userId = :k OR begins_with(userId, :p)' \
       --expression-attribute-values "{\":k\":{\"S\":\"$K\"},\":p\":{\"S\":\"$K:\"}}" \
       --query 'Items[].userId.S' --output text | tr '\t' '\n' | while read -r key; do
       [ -n "$key" ] && [ "$key" != None ] || continue
       aws dynamodb delete-item --table-name "$TABLE" --region <region> \
         --key "{\"userId\":{\"S\":\"$key\"}}"
     done
     ```

   - **The account-level link was wrong:** its records are spread across every unrecognised voice and every
     `:account` record, so delete every item in the table. Everyone's lists and preferences start again; nothing else
     is lost.

     ```sh
     aws dynamodb scan --table-name "$TABLE" --region <region> --projection-expression userId \
       --query 'Items[].userId.S' --output text | tr '\t' '\n' | while read -r key; do
       [ -n "$key" ] && [ "$key" != None ] || continue
       aws dynamodb delete-item --table-name "$TABLE" --region <region> \
         --key "{\"userId\":{\"S\":\"$key\"}}"
     done
     ```

4. Try "my issues", "open two", "more", "read the description", "where am I", "repeat" and "stop".
5. **Refresh.** More than an hour after linking, and after YouTrack's `expires_in` has passed, make a request. Pass:
   `linkedVia` is `person` and there is no `failure: unauthorized`. Fail: `alexa.link.missing` or `unauthorized`, which
   means no refresh token was issued (check `access_type=offline` and the `offline_access` scope in step 4).
6. Check a spelled id ("open issue why ay one four") to see what AMAZON.AlphaNumeric returns.
7. **Revocation.** To end access, delete the token in YouTrack (the household member's profile > Account Security)
   **and** unlink in the Alexa app. Disabling the skill alone does not revoke YouTrack's refresh token. Deleting the
   OAuth client ends access for everyone. What the skill says today after a revocation:
   - "Not linked yet": Alexa's own refresh failed and it dropped the token.
   - On the **account-level** link, if Alexa still sends the revoked token: "your tracker account link has expired or
     was removed". The link check before the turn gets YouTrack's 401.
   - On a **person's own** link, if Alexa still sends the revoked token: "The tracker wouldn't let me read that." The
     core catches the 401 like any refusal. Speaking relink there too is YA-28.

   Pass: one of those, and no tracker content.

## Linking without the Alexa app (YA-33)

**Issue:** YA-33. **Not deployed.** It has been through a security and a correctness review (fixes landed,
2026-09-13). Every live step below is Owner operates, asked for first.

**Why.** On 2026-09-13 the Alexa iOS app could not link this skill (YA-14 comments):

- The Alexa+ card has no Link Account button.
- The classic app fails in 1-2 s without opening a browser, which the diagnostic page proved.

YouTrack's Hub also enforces PKCE even with the client's checkbox off, and Amazon's server-side code exchange sends no
`code_verifier`.

**What.** An OAuth link broker, the function `youtrack-voice-link` (`src/voice/link-broker/`), in the same stack behind
a public Function URL. It sits between Alexa and YouTrack:

- Toward YouTrack it is the client `alexa-voice-client`, with its own PKCE and the YouTrack client secret.
- Toward Alexa it is the authorization server. It issues one-time codes of its own, and proxies refreshes to YouTrack.
- It links only the household YouTrack account, identified by its **Hub user id**
  `<household Hub user id>` (login `Household_User`). Any other account is refused and nothing is stored.

The routes, in the order the owner's link uses them:

| Route | Who calls it | What it does |
|---|---|---|
| `GET /start?k=<setup key>` | the Owner's phone browser | Checks the setup key (read from SSM each time), sends the browser to Login with Amazon |
| `GET /amazon-callback` | Login with Amazon's redirect | Gets the Amazon token, then sends the browser to YouTrack |
| `GET /youtrack-callback` | YouTrack's redirect | Exchanges the code, checks the Hub user id, calls the Skill Enablement API with a broker code |
| `POST /token` | Amazon (HTTP Basic) | Redeems the broker code for the YouTrack tokens, or proxies a refresh |
| `GET /authorize` | nobody | **Off** (`LinkBrokerAuthorize=off`): Alexa-initiated linking, for the day the Alexa app can link |

**Why Amazon comes first.** Hub issues this client a refresh token "the first time it exchanges an authorization code
for a user". Anything that fails after that exchange spends the household's one refresh token, and every retry then
gets none until an administrator removes it
([Recover a spent YouTrack refresh token](#recover-a-spent-youtrack-refresh-token)). So every Amazon step that can fail on first-time configuration runs before YouTrack is asked, and only the account
check and the Enablement API call follow the exchange. Every page after it says how to recover.

**Security properties** (tests in `test/voice/link-broker/`):

- **States:** 256-bit, single use, 10 minutes. **Broker codes:** 256-bit, single use, 5 minutes. Both are taken by a
  conditional DynamoDB delete.
- **Link table:** holds no state, code or token in the clear. Each record is keyed by an HKDF of its one-time value
  and sealed with AES-256-GCM under another HKDF of it. The customer's Amazon token waits there, sealed, for at most
  10 minutes.
- **`/token`:** Basic client authentication with constant-time compares. `redirect_uri` must match the code's.
- **Household:** the Hub user id YouTrack reports (`ringId`) must equal `HouseholdHubUserId` exactly. A login can be
  renamed or case-folded; the id cannot.
- **`/authorize`** is off by default, which closes link CSRF from someone else's Alexa account.
- **`/start`** reads the setup key from SSM on every request. Deleting the parameter turns it off at once.
- **Logs and pages:** logs carry tags, statuses and timings, never a secret, token, code, state, verifier or key, at
  any level. Pages are plain, escaped, `no-store` and `no-referrer`, with no CORS headers.
- **Secrets:** six SSM SecureString parameters under `/youtrack-voice/link-broker/`. None is in the template or the
  environment.
  - `youtrack-client-secret`, `broker-client-id` and `broker-client-secret` serve `/token`. They are read in one
    `GetParameters` call at Lambda init and kept for the environment's life.
  - `setup-key`, `lwa-client-id` and `lwa-client-secret` serve only `/start`. They are read per request and deleted
    after linking (step 8).
- **Refresh:** only Hub's `invalid_grant` is passed on as `invalid_grant`, which tells Amazon the link is gone. A
  broker-side failure answers `server_error` or `temporarily_unavailable`, so it does not unlink the household.
- **Amazon's 4.5 s:** the handler is built at Lambda init, the function has 1024 MB, and the YouTrack refresh call gets
  what remains of a 4 s budget counted from the invocation's start. Each `link.request` line logs `coldStart` and
  `sinceInvocationMs`.

**The broker has to stay up while the link is used.** Amazon refreshes through `/token`, about hourly, so deleting or
throttling the broker ends the link within the hour.

### Where the docs differ from the YA-33 brief

Checked 2026-09-13. Page dates are the pages' own "Last updated" footers.

1. **There is no separate Login with Amazon security profile.**
   - For app-to-app linking, `client_id` is "The Alexa client ID that the Alexa developer console provides when you
     enable app-to-app account linking".
   - `client_secret` is "The Alexa client secret that the developer console provides".
   - The SSM parameters `lwa-client-id` and `lwa-client-secret` hold those two values.
   - (App-to-app account linking starting from your app, Jul 14, 2026)
2. **"Your Redirect URLs"** are where Amazon sends the Amazon authorization code back: "Alexa and LWA use these URLs
   to send the user back to your app". That is the broker's `/amazon-callback`. (Step 3, no page date)
3. **The enablement `redirectUri`** is "the same value as the redirect_uri parameter included in the authorization
   request to your OAuth 2.0 server to obtain the user's authorization code". Amazon passes it to the Access Token
   URI. No doc requires it to be one of "Your Redirect URLs". The broker sends `/amazon-callback` and binds its code
   to that. (Skill Enablement API, Jul 14, 2026)
4. **A development-stage skill can be linked this way.** "Until your skill is published, you must set the stage value
   to development". But "Only the developer account used to create the skill and any accounts you manually add as
   beta testing accounts can request operations". The owner's Amazon account is both. (Step 6; troubleshooting, Jul 14,
   2026)
5. **A 201 does not mean linked.** The answer carries `accountLink.status`, `LINKED` or `NOT_LINKED`. The broker
   shows "Linked" only for `LINKED` with its code redeemed at `/token`. (Skill Enablement API, Jul 14, 2026)
6. **HTTP Basic is not "recommended".** "Amazon supports HTTP basic and credentials in the request body". The broker
   accepts Basic only, so the console must say HTTP Basic. (Troubleshooting, Jul 14, 2026)
7. **Hub has no OAuth revocation endpoint.** Only an administrator's REST calls list and remove a user's refresh
   tokens: `GET <Hub REST API URL>/users/{user id}/refreshtokens` and
   `DELETE <Hub REST API URL>/users/{user id}/refreshtokens/{refresh token id}`, where the REST API URL is
   `https://example.youtrack.cloud/hub/api/rest`. (Hub REST, Refresh Tokens of User, 14 October 2024; REST API URL
   page, no date)
8. **Hub issues a refresh token "the first time it exchanges an authorization code for a user".** Hence the order
   above and the recovery section. (Hub Authorization Code, 10 September 2026)
9. **Hub's refresh token lifetime is configurable, and the docs do not say where.**
   - "Since Hub 2023.1, refresh tokens are valid only for the configured period of time." (Hub Refresh Token,
     10 September 2026)
   - No JetBrains page found names the setting or its location.
   - Amazon asks for "at least 180 days or to never expire". (Requirements for account linking, Jul 14, 2026)
   - The check that works is reading the `expires` field Hub reports on the token itself. Its `refreshToken` schema has
     `creationTime` and `expires`. (Hub REST JSON scheme)
   - Steps 6 and 8 read it.
10. **Refresh `scope`.**
    - Hub's refresh parameter table marks `scope` "Required". Its prose says an omitted scope "is treated as equal to
      the scope originally granted".
    - The broker sends it, exactly as in the authorization request. (Hub Refresh Token, 10 September 2026)
11. **Amazon expects the Access Token URI to answer within 4.5 s**, and access tokens of at least 3600 s; Hub's are
    3600 s. (Requirements for account linking, Jul 14, 2026)
12. **`ringId` is "ID of the user in Hub"** on YouTrack's `User` entity, returned by `/api/users/me`. (YouTrack REST,
    User, 01 July 2026)
13. **`sam deploy` and an empty parameter.**
    - Checked in SAM CLI 1.166.2's source, not live. `--parameter-overrides EnrolledPersonId=` is refused ("is not a
      valid format"). `ParameterKey=EnrolledPersonId,ParameterValue=` parses as a key named
      `EnrolledPersonId,ParameterValue=`, so the value is silently not set.
    - `EnrolledPersonId=""` parses to the empty string, but the double quotes must reach SAM: write
      `'EnrolledPersonId=""'` in the shell.
    - A parameter left out of `--parameter-overrides` is sent as `UsePreviousValue` and keeps its live value.

### The steps

All commands run from the repository root on the Owner's Mac, **in bash** (`bash`, then paste): zsh's `read` takes
different options. Region `us-east-1`, stack `youtrack-voice`. No secret value is typed on a command line, echoed, or
written to a file. Each value is pasted at a hidden prompt, or generated and stored without being shown. It reaches the
AWS CLI or curl on standard input, never as an argument that `ps` could show.

Define these once in that bash session:

```bash
P=/youtrack-voice/link-broker
R=us-east-1
HUB_REST=https://example.youtrack.cloud/hub/api/rest
HOUSEHOLD_HUB_ID=<household Hub user id>

# Paste a value at a hidden prompt; it goes to SSM on stdin and is never shown.
put_secret() {
  local value
  IFS= read -rsp "Paste $1 (hidden), then Enter: " value; echo
  [ -n "$value" ] || { echo "empty, nothing stored"; return 1; }
  printf '%s' "$value" | aws ssm put-parameter --region "$R" --name "$P/$1" --type SecureString --overwrite \
    --value file:///dev/stdin --query Version --output text
  unset value
}

# Generate a 64-hex-character value and store it, never shown.
gen_secret() {
  openssl rand -hex 32 | tr -d '\n' | aws ssm put-parameter --region "$R" --name "$P/$1" --type SecureString \
    --overwrite --value file:///dev/stdin --query Version --output text
}

# Copy a stored value to the clipboard, never the screen. Clear the clipboards afterwards (clear_clipboards).
copy_secret() {
  aws ssm get-parameter --region "$R" --name "$P/$1" --with-decryption --query Parameter.Value --output text \
    | tr -d '\n' | pbcopy
}

clear_clipboards() {
  printf '' | pbcopy
  echo "Mac clipboard cleared. On the iPhone, copy any harmless word now:"
  echo "Universal Clipboard left the last value there."
}

# Hub REST as a YouTrack administrator. The permanent token is pasted once, hidden, and sent to curl on stdin.
hub_admin_login() {
  IFS= read -rsp "Paste a YouTrack administrator's permanent token with the Hub scope (hidden): " HUB_ADMIN_TOKEN; echo
}
hub() {  # usage: hub GET|DELETE <path under the Hub REST API URL>
  printf 'Authorization: Bearer %s\nAccept: application/json\n' "$HUB_ADMIN_TOKEN" \
    | curl -sS -X "$1" -H @- "$HUB_REST$2" -w '\nHTTP %{http_code}\n'
}
```

**The administrator token** for `hub_admin_login`:

1. In YouTrack, open **your own** profile > Account Security > New token.
2. Choose the **YouTrack Administration** scope (the Hub service), and name it `ya33-refresh-tokens`.
3. Copy it, run `hub_admin_login`, and paste.
4. Delete it when step 8 is done.

It needs the Update User permission (Manage authentication tokens, 23 July 2026). **[UNVERIFIED]** the scope's exact
label in the token dialog: pick the one that names Hub or administration.

#### 1. Approve and deploy: the skill function stays exactly as it is live

**Who:** Owner operates, asked first.

**What this deploy changes.** It adds the link function, its Function URL, its table, its log group and its role. It
changes **nothing** about the skill function (`youtrack-voice-alexa`). The command below is **the full-entry command
from step 2.3 with only the broker parameters added**, and every skill value in it is the value live since the
2026-09-13 deploy:

`EntryHandler=voice/alexa/deploy/lambda-entry.handler`, `YouTrackBaseUrl=https://example.youtrack.cloud`,
`YouTrackProject=H`, `HouseholdLogin=Household_User`, `ReadAccepts=person,account`, `WriteAccepts=person`,
`AccountTokenFallback=true`, `Cards=off`, `EnrolmentLog=false`, `LogLevel=info`, `StateTtlDays=90`,
`LogRetentionDays=30`, and `EnrolledPersonId` empty.

1. Record the skill function's live configuration, to compare after the deploy:

   ```bash
   aws cloudformation describe-stacks --stack-name youtrack-voice --region us-east-1 \
     --query 'Stacks[0].Parameters' --output table
   aws lambda get-function-configuration --function-name youtrack-voice-alexa --region us-east-1 \
     --query '{h:Handler,m:MemorySize,t:Timeout,env:Environment.Variables}' --output json > /tmp/alexa-before.json
   ```

   If any skill value in the table differs from the list above, stop and ask: the command would change it.

2. Build both entries into the one code directory the template uses. `lambda-entry.ts` is the entry the skill already
   runs:

   ```bash
   npm ci
   rm -rf src/voice/alexa/deploy/.build
   npx tsc src/voice/alexa/deploy/lambda-entry.ts src/voice/link-broker/deploy/entry.ts \
     --outDir src/voice/alexa/deploy/.build/lambda --rootDir src \
     --module nodenext --moduleResolution nodenext --target es2022 --rewriteRelativeImportExtensions \
     --verbatimModuleSyntax --strict --skipLibCheck --types node
   echo '{"type":"module"}' > src/voice/alexa/deploy/.build/lambda/package.json
   ```

3. Deploy. The first three lines of overrides are the full-entry command's; the last three are the broker's.
   `'EnrolledPersonId=""'` keeps it empty: the single quotes carry the double quotes through to SAM (finding 13).

   ```bash
   sam deploy --template-file src/voice/alexa/deploy/template.yaml --stack-name youtrack-voice \
     --region us-east-1 --capabilities CAPABILITY_IAM --resolve-s3 --no-fail-on-empty-changeset --on-failure DELETE --confirm-changeset \
     --parameter-overrides SkillId=<skill id> \
       EntryHandler=voice/alexa/deploy/lambda-entry.handler 'EnrolledPersonId=""' ReadAccepts=person,account \
       WriteAccepts=person AccountTokenFallback=true Cards=off EnrolmentLog=false LogLevel=info \
       YouTrackBaseUrl=https://example.youtrack.cloud YouTrackProject=H HouseholdLogin=Household_User \
       StateTtlDays=90 LogRetentionDays=30 \
       LinkBroker=on YouTrackClientId=alexa-voice-client \
       'YouTrackScope="<YouTrack service id> offline_access"' AlexaVendorId=<vendor id> \
       HouseholdHubUserId=<household Hub user id> SkillStage=development LinkBrokerAuthorize=off \
       LinkBrokerSecretsEpoch=1 LinkBrokerOrigin=auto
   ```

   `--confirm-changeset` makes SAM stop and show the changeset before anything changes (SAM does not ask by
   default). Expect **`Link*` resources as Add**, and the skill **`Function` as Modify**: both functions are built
   from the same `.build/lambda` folder, so the skill gets a new code artifact from the same source with the same
   configuration. Nothing else should appear. Anything else, especially a change to `StateTable`, the skill's
   permission or its log group, means stop and answer `n`. The template's rules refuse `LinkBroker=on` without the
   scope, vendor id, YouTrack URL, household login or Hub user id.

4. Confirm the skill function did not change: this prints nothing when it is identical.

   ```bash
   aws lambda get-function-configuration --function-name youtrack-voice-alexa --region us-east-1 \
     --query '{h:Handler,m:MemorySize,t:Timeout,env:Environment.Variables}' --output json | diff /tmp/alexa-before.json -
   ```

5. Keep the broker's origin in the session, without its trailing slash. It is not a secret.

   ```bash
   B=$(aws cloudformation describe-stacks --stack-name youtrack-voice --region us-east-1 \
     --query "Stacks[0].Outputs[?OutputKey=='LinkBrokerUrl'].OutputValue" --output text | sed 's:/*$::')
   echo "$B"
   ```

6. **Pin the origin** (a second deploy, asked for with this one). Run the step 1.3 command again with only
   `LinkBrokerOrigin=auto` replaced by `LinkBrokerOrigin=<the value echo "$B" printed>`. The broker then refuses
   requests for any other host name, and uses only that origin in redirect URIs.

#### 2. The broker's own credentials and the setup key

**Who:** Owner. These values leave SSM only by clipboard: into the Alexa console (step 4) and the phone (step 7).

```bash
openssl rand -hex 16 | sed 's/^/alexa-link-/' | tr -d '\n' | aws ssm put-parameter --region "$R" \
  --name "$P/broker-client-id" --type SecureString --overwrite --value file:///dev/stdin --query Version --output text
gen_secret broker-client-secret
gen_secret setup-key
```

#### 3. The YouTrack side

**Who:** Owner, as YouTrack administrator.

1. In Administration > Access Management > OAuth Clients > **Alexa voice client**, add the redirect URI
   `<$B>/youtrack-callback`, where `<$B>` is the value `echo "$B"` printed.
2. Give the broker the client secret. The value the Alexa console held until now is rotated after linking (step 8.4).
   If YouTrack cannot show it, use **Change** now. Store it at the prompt:

   ```bash
   put_secret youtrack-client-secret
   ```

#### 4. The Alexa developer console

**Who:** Owner, signed in with their Amazon developer account. Skill **My Tracker** (`amzn1.ask.skill.…`),
Build > Tools > **Account linking**. Development stage.

1. Keep account linking on. Keep "Allow users to enable skill without account linking" as it is. Leave **"Allow users
   to authenticate using your mobile application"** off: it would make the iOS and Android App Authorization URIs
   required.
2. Turn on **Allow users to link their account to your skill from within your application or website**.
3. Set:
   - Authorization grant type: **Auth Code Grant**.
   - Your Web Authorization URI: `<$B>/authorize`, with no query string. The console requires one; the broker answers
     it with "not enabled" while `LinkBrokerAuthorize=off`.
   - Access Token URI: `<$B>/token`.
   - Your Client ID: run `copy_secret broker-client-id`, then paste.
   - Your Secret: run `copy_secret broker-client-secret`, then paste.
   - Your Authentication Scheme: **HTTP Basic**. The broker refuses credentials in the body.
   - Scope: `youtrack`. The broker ignores Alexa's scope.
   - Domain List: `example.youtrack.cloud`.
   - Default Access Token Expiration Time: leave empty. Hub sends `expires_in`.
   - PKCE: leave it as it is. The broker does not need Alexa's PKCE for app-to-app linking, because `/token` requires
     Basic client authentication. If the Enablement API answers 400 in step 7, turning PKCE off here is the first
     thing to try (nothing documents whether it makes Amazon expect `authCodeVerifier`).
   - **Your Redirect URLs:** `<$B>/amazon-callback`, and nothing else.
4. Save. The page shows the **Alexa Client ID** and **Alexa Client Secret** for app-to-app linking (**[UNVERIFIED]**
   whether they appear before or only after Save). Copy each into SSM at the prompt:

   ```bash
   put_secret lwa-client-id
   put_secret lwa-client-secret
   ```

5. `clear_clipboards`.

#### 5. Check the broker starts

**Who:** Owner. Nothing here changes anything.

```bash
curl -s "$B/start" | grep -o '<h1>[^<]*</h1>'
curl -s "$B/authorize" | grep -o '<h1>[^<]*</h1>'
aws logs tail /aws/lambda/youtrack-voice-link --region us-east-1 --since 10m --format short
```

- Expect `Setup link not valid` (the key exists, and none was given) and `Alexa-initiated linking is not enabled`.
- Expect a `link.entry.ready` line.
- A `link.entry.startFailed` line names the parameter or variable that is missing; fix that step. The next request
  builds again, so nothing needs forcing.

#### 6. Before /start: no old refresh token, and the lifetime Hub gives

**Who:** Owner, as YouTrack administrator. Run `hub_admin_login` first.

```bash
hub GET "/users/$HOUSEHOLD_HUB_ID/refreshtokens?fields=id,client(id,name),creationTime,expires,lastAccessTime"
```

- **A token whose client is "Alexa voice client"** would make YouTrack issue no refresh token in step 7. Remove it with
  [the recovery call](#recover-a-spent-youtrack-refresh-token).
- **Any token's `expires` minus `creationTime`** shows Hub's configured lifetime. **[UNVERIFIED]** that both are
  epoch milliseconds, which is how Hub's REST API usually gives times. 180 days is 15552000000 ms.
  - If it is shorter, find the refresh token lifetime in YouTrack's administration settings and raise it to at least
    180 days, or to no expiry. The docs do not name the page (finding 9).
  - A shorter lifetime unlinks the household every time it runs out.
- **No tokens at all** is expected. Step 8.2 checks the new token's lifetime instead.

#### 7. Link: open /start in the phone's browser and sign in twice

**Who:** Owner, with the iPhone. About five minutes; each sign-in must finish within ten.

1. On the Mac, put the setup URL on the clipboard. Universal Clipboard carries it to the iPhone:

   ```bash
   printf '%s/start?k=%s' "$B" "$(aws ssm get-parameter --region "$R" --name "$P/setup-key" --with-decryption \
     --query Parameter.Value --output text)" | pbcopy
   ```

2. On the iPhone, open a **private** Safari tab and paste the URL.
3. **Amazon first.** Login with Amazon asks you to sign in: use the owner's Amazon account, and allow.
   - If this fails ("Amazon did not sign you in", "Amazon refused the sign-in", "not configured"), nothing was asked
     of YouTrack.
   - Fix what the page says (usually step 4) and start again from 7.1.
4. **YouTrack second.** YouTrack shows its login form (`request_credentials=required`). Sign in as **Household_User**
   (the household account), and approve the Alexa voice client.
5. The page says **Linked**, and shows Amazon's answer with `"accountLink":{"status":"LINKED"}`.
   - **"Not linked"** (any status other than LINKED), **"YouTrack issued no refresh token"**, **"YouTrack account not
     confirmed"** or **"YouTrack could not be reached"** mean the household's refresh token may be spent.
     1. Do [Recover a spent YouTrack refresh token](#recover-a-spent-youtrack-refresh-token).
     2. Fix what the page says.
     3. Start again from 7.1.
   - **"Wrong YouTrack account"** means another account signed in. The household's token is untouched, so start again
     from 7.1.
6. On the Mac, run `clear_clipboards`, and copy a harmless word on the iPhone as it says. Close the private tab. If a
   clipboard manager keeps history on either device, delete the entry there too.

#### 8. Verify, then close everything that linking needed

**Who:** the household member, with the Owner verifying.

1. Say **"Alexa, open issue desk"**, then **"my issues"**. It reads the household's issues in H, not the link prompt.
2. The logs, and the new token's lifetime:

   ```bash
   aws logs tail /aws/lambda/youtrack-voice-link --region us-east-1 --since 30m --format short
   hub GET "/users/$HOUSEHOLD_HUB_ID/refreshtokens?fields=id,client(id,name),creationTime,expires,lastAccessTime"
   ```

   - **Expect, in order:**
     1. `link.lwa.exchanged`
     2. `link.youtrack.exchanged` with `"refreshToken":"present"`
     3. `link.youtrack.accountChecked` with `"match":true`
     4. `link.code.issued`
     5. `link.token.issued`
     6. `link.enablement.answered` with `"accountLinkStatus":"LINKED"` and `"linked":true`
   - **The `/token` line.** Its `link.request` line shows `"coldStart":true` and `sinceInvocationMs`. If that is above
     about 3000, raise it with the Director: provisioned concurrency is the next step.
   - **The token.** Exactly one Alexa voice client token, whose `expires` is at least 180 days after `creationTime` (or
     absent).
3. **Close /start.** Delete the three setup parameters. `/start` is off at once, and the refresh path never reads
   them:

   ```bash
   aws ssm delete-parameters --region "$R" --names "$P/setup-key" "$P/lwa-client-id" "$P/lwa-client-secret"
   curl -s "$B/start" | grep -o '<h1>[^<]*</h1>'
   ```

   Expect `Setup linking is turned off`. If Amazon can regenerate the Alexa Client Secret in the console, do that too.
   To relink later: `gen_secret setup-key`, then `put_secret lwa-client-id` and `put_secret lwa-client-secret`, then
   step 6 and step 7.
4. **Rotate the YouTrack client secret.** The old value was in the Alexa console and the YA-14 setup.
   1. In YouTrack, **Change** the Alexa voice client's secret.
   2. `put_secret youtrack-client-secret`.
   3. Replace the broker's environments: run the step 1.3 command (with the pinned origin from 1.6) with
      `LinkBrokerSecretsEpoch=2`.
   4. Within about an hour of the next use, expect `link.refresh.proxied` in the logs. **[UNVERIFIED]** whether Hub
      keeps refresh tokens valid across a client secret change. If the log shows `link.refresh.failed` with `invalid_grant`,
      relink: step 8.3's relink line, then the recovery section.
5. **Remove the three Alexa redirect URIs** (`pitangui`, `layla`, `alexa.amazon.co.jp`) from the YouTrack OAuth client:
   with the broker in front, Alexa never goes to YouTrack directly.
6. **At the one-hour mark,** check for `link.refresh.proxied`. It shows Hub accepted the refresh with the broker's
   `scope`.
7. Delete the `ya33-refresh-tokens` administrator token, and `unset HUB_ADMIN_TOKEN`.

### Recover a spent YouTrack refresh token

**When:** a step 7 page says to, or step 6 found an Alexa voice client token. **Who:** a YouTrack administrator. Nothing
secret appears on screen or in `ps`. The Hub REST calls are documented at
https://www.jetbrains.com/help/youtrack/devportal/HUB-REST-API_Users_Refresh-Tokens-of-User.html (14 October 2024).

```bash
hub_admin_login   # once per bash session
# 1. List the household account's refresh tokens.
hub GET "/users/$HOUSEHOLD_HUB_ID/refreshtokens?fields=id,client(id,name),creationTime,expires"
# 2. Remove the one whose client name is "Alexa voice client", by its id.
hub DELETE "/users/$HOUSEHOLD_HUB_ID/refreshtokens/<refresh token id from step 1>"
# 3. List again: it is gone.
hub GET "/users/$HOUSEHOLD_HUB_ID/refreshtokens?fields=id,client(id,name)"
```

- Expect `HTTP 200` from each call; `HTTP 403` means the token lacks the permission or the scope.
- Removing the token also ends any link Amazon holds with it. That is intended when relinking.
- Then start again from step 7.1, with a new setup link.
- A **"Wrong YouTrack account"** page left a token on that other account. Remove it the same way, with that account's
  Hub user id: Administration > Users > the account, or the `ringId` from `GET /api/users?fields=login,ringId`.

The Account Security tab also lists authentication tokens (Manage authentication tokens, 23 July 2026).
**[UNVERIFIED]** whether it shows refresh tokens; the REST call above is the documented route.

### Rotate, disable, remove

- **Rotate a broker credential** (`broker-client-id` or `broker-client-secret`).
  1. `gen_secret broker-client-secret`.
  2. Paste it into the console (step 4.3).
  3. Deploy with the next `LinkBrokerSecretsEpoch`.
  - Amazon uses the console's value for every later refresh, so do all three together. **[UNVERIFIED]** whether a
    refresh in the gap unlinks; check the logs for `link.token.refused`.
- **Rotate the YouTrack client secret:** step 8.4. A refresh between the change and the new environments answers
  `server_error`, which does not unlink.
- **Turn /start on or off:** create or delete `setup-key` (steps 2 and 8.3). It takes effect on the next request.
- **Disable the broker at once:**
  `aws lambda put-function-concurrency --function-name youtrack-voice-link --reserved-concurrent-executions 0 --region us-east-1`.
  - Refreshes then fail, and the link stops working within the hour.
  - To undo it: `aws lambda delete-function-concurrency --function-name youtrack-voice-link --region us-east-1`.
- **Unlink:** in the Alexa app, or with the Skill Enablement API's `DELETE`. Then remove the refresh token (recovery
  section).
- **Remove the broker:**
  1. Deploy with `LinkBroker=off`.
  2. In the console, point account linking back at YouTrack (step 4 of the main runbook).
  3. Delete the parameters:
     `aws ssm delete-parameters --region us-east-1 --names $P/youtrack-client-secret $P/lwa-client-id $P/lwa-client-secret $P/broker-client-id $P/broker-client-secret $P/setup-key`.

### Open questions after review

Fixed in this round:

- **C1:** Amazon first, and the recovery section.
- **C2:** "Linked" only for `LINKED`.
- **C3:** the deploy command keeps the skill's live values.
- **C4:** the init build, 1024 MB, the budgeted refresh timeout, and `coldStart` logging.
- **C5:** the refresh `scope`.
- **C6:** the lifetime check.
- **S1:** `/authorize` off.
- **S2:** the setup key read per request.
- **S4:** the Hub user id.
- **S10:** runbook hardening.

Still open, filed by the Director as follow-ups:

- **Security:** S3 (concurrency isolation, cost alarms), S5 (browser binding and pinning the Amazon account on
  `/start`), S6 (transformed secrets on error pages), S7 (enablement timeout wording), S8 (attacker text in logs
  before client authentication), S9 (the refresh proxy's household check).
- **Correctness:** C7 (`expires_in` after time in the table), C8 (form-encoding in Basic toward Hub), C9 (console
  details).
- **To observe on the first link:**
  - whether Hub's second exchange really omits the refresh token;
  - where the lifetime setting lives;
  - whether a client secret change keeps refresh tokens valid;
  - the cold `/token` time.

### Sources (checked 2026-09-13)

- Skill Enablement API reference: the endpoint, hosts, request body (`stage`, `accountLinkRequest`, optional
  `authCodeVerifier`), the 201 response with `accountLink.status` `LINKED` or `NOT_LINKED`, errors, GET and DELETE
  (Jul 14, 2026). https://developer.amazon.com/en-US/docs/alexa/smapi/skill-enablement.html
- App-to-app account linking starting from your app: `alexa::skills:account_linking`, the Alexa client id and secret,
  and the `https://www.amazon.com/ap/oa` fallback URL (Jul 14, 2026).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/app-to-app-account-linking-starting-from-your-app.html
- Step 3, configure the redirect URLs: the console setting and "Your Redirect URLs" (no page date).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/your-app-to-alexa-step3.html
- Step 5, the access token request: `POST https://api.amazon.com/auth/o2/token` with `client_id`, `client_secret`,
  `code_verifier` and `redirect_uri` (no page date).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/your-app-to-alexa-step5.html
- Step 6, enable the skill: `stage` development until published, and the error table (no page date).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/your-app-to-alexa-step6.html
- Configure authorization code grant: Your Redirect URLs, the authentication scheme, the mobile-app setting, and
  refresh through the Access Token URI (Jul 14, 2026).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/configure-authorization-code-grant.html
- Troubleshooting account linking: HTTP Basic or body credentials, and who may call a development-stage skill
  (Jul 14, 2026). https://developer.amazon.com/en-US/docs/alexa/account-linking/troubleshooting-account-linking.html
- Requirements for account linking: the 4.5 s answer, `expires_in`, a refresh token TTL of at least 180 days, and
  `invalid_grant` only to break a link (Jul 14, 2026).
  https://developer.amazon.com/en-US/docs/alexa/account-linking/requirements-account-linking.html
- Hub authorization code flow: `access_type=offline` ("the first time"), `request_credentials`, PKCE, and the token
  response (10 September 2026). https://www.jetbrains.com/help/youtrack/devportal/Authorization-Code.html
- Hub refresh token: "valid only for the configured period of time", `scope` "Required", and "Hub may issue a new
  refresh token" (10 September 2026). https://www.jetbrains.com/help/youtrack/devportal/Refresh-Token.html
- Hub REST, refresh tokens of a user: get all, and remove (14 October 2024).
  https://www.jetbrains.com/help/youtrack/devportal/HUB-REST-API_Users_Refresh-Tokens-of-User_Get-All-Refresh-Tokens-of-a-User.html
  and
  https://www.jetbrains.com/help/youtrack/devportal/HUB-REST-API_Users_Refresh-Tokens-of-User_Remove-Refresh-Token-from-Refresh-Tokens-of-a-User.html
- Hub REST API URL, `<Hub Service URL>/api/rest/`:
  https://www.jetbrains.com/help/youtrack/devportal/Hub-Rest-Api-URL.html
- Hub REST JSON scheme, `refreshToken` (`client`, `creationTime`, `expires`):
  https://www.jetbrains.com/help/youtrack/devportal/HUB-REST-API_JSON-Scheme.html
- YouTrack REST, `User.ringId` "ID of the user in Hub" (01 July 2026):
  https://www.jetbrains.com/help/youtrack/devportal/api-entity-User.html
- Manage authentication tokens: permanent tokens, Update User, and the Account Security tab (23 July 2026).
  https://www.jetbrains.com/help/youtrack/cloud/manage-authentication-tokens.html
- Lambda Function URLs: a NONE auth type needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` since
  October 2025, and `lambda:InvokedViaFunctionUrl`. https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
- SAM CLI 1.166.2 source: `CfnParameterOverridesType` (the empty-value forms) and `DeployContext.merge_parameters`
  (`UsePreviousValue` for parameters left out).
- RFC 6749 (OAuth 2.0), RFC 7636 (PKCE; appendix B's S256 test vector is in the tests).

## Air quality (YA-36, YA-37)

"Alexa, ask issue desk for the air quality", or "...what's the air quality in Missoula", answered from PurpleAir's
outdoor sensors, in the same skill. The household guide's "Air quality" section has the phrasings and replies; this
section is how it works and how the Owner turns it on. Checked against vendor documentation on 2026-09-14 (Sources,
below), and revised after the correctness and security reviews of `0418836`.

### How it answers

- **Here** is the Echo's country and postal code, from the Device Address API, asked only on an air-quality turn,
  alongside the time-zone lookup, with a 500 ms limit. Refused (403), empty (204), failing or slow, the core uses the
  home location instead. The reply says "near you" or "at home": the Echo's postal code is never spoken, so it is never
  in the saved last reply either. With neither, it says it does not know where the device is. The street address is
  never requested: the skill calls only `/v1/devices/{deviceId}/settings/address/countryAndPostalCode`.
- **Named words** ("in Missoula", "in 59802", "at Rattlesnake Creek") are resolved near the household: the Echo's
  point, else home.
  1. A PurpleAir sensor within 15 km whose name matches strongly (every word said exactly, and more than half of the
     sensor's own name said) wins. "Rattlesnake Creek" is the sensor "Rattlesnake Creek Upper"; "Missoula" is not the
     sensor "Downtown Missoula".
  2. Otherwise the town or postal code the geocoder ranks first, when it is within 300 km and matched well
     (`MatchScores.Overall` at least 0.8). It is said as the listener said it.
  3. Otherwise a sensor whose name matches at all.
  4. Otherwise a distant or weaker place, said by its own name ("Portland, Oregon"). When two or three places share
     that name with close scores, the skill asks: "Did you mean Springfield, Missouri, or Springfield, Illinois? Say
     'one' or 'two'." The answer is a number, which works without a linked account in that session only.
  The geocoder is asked with `BiasPosition` at the household's point and only `Locality` and `PostalCode` place
  types, so a street, building or point of interest that shares a sensor's name is never taken for the place.
- **The data.** `GET https://api.purpleair.com/v1/sensors` with the read key in `X-API-Key`, `location_type=0`
  (outside), `max_age=3600`, and a bounding box. An area asks for six fields (`latitude`, `longitude`, `last_seen`,
  `humidity`, `pm2.5_10minute`, `confidence`) and no name. A name search asks for `name` alone in a 15 km box, and
  then the readings of at most five matching sensors by `show_only`. PurpleAir has no parameter that caps the rows returned, so the boxes
  bound the cost.
- **The figure for a named place.** First the sensors within 5 km. Only when fewer than three of them are usable does a second fetch go
  out to 15 km, and its sensors are **added** to the near ones, never replacing them. So a 15 km box is only ever asked
  for where the 5 km box was nearly empty. Each sensor's 10-minute average is corrected with the US EPA's extended
  PurpleAir correction.
  - **Outliers:** within each distance band (near, far) separately, and only with three or more sensors in the band, a
    value further from the band's median than both 5 µg/m³ and three scaled median absolute deviations is set aside.
  - **Plausibility** (correctness recheck N1): a row whose `confidence` is below 50, or whose corrected PM2.5 is
    outside 0 to 1000 µg/m³, is set aside. `confidence` is PurpleAir's "average of confidence_manual and
    confidence_auto", each "indicating how closely channel A and B pseudo averages match", at one field per row. A
    broken sensor reading 999 corrects to about 1574 and is dropped.
  - **Weighting:** the figure is the median weighted by 1 / max(distance, 1 km), so the nearest sensors lead.
  - **Disagreement** (N1): one or two sensors never decide silently. The two groups are compared when the near band
    has fewer than three sensors and there are sensors further out, or when only two sensors are kept at all. If they
    disagree wildly (two or more AQI categories apart, or three times apart and at least 10 µg/m³), the higher group
    leads and both are said: "Readings nearby disagree: AQI 135 from 1 sensor, and AQI 27 from 3 others ...", then
    "Take it as a rough guide." A near sensor reading 0 beside Moderate sensors further out is therefore Moderate, and
    says so.
  - **AQI:** from EPA's 2024 PM2.5 breakpoints, truncated to 0.1 µg/m³ and rounded. Above 325.4 µg/m³ the index goes
    on past 500 on the Hazardous line's slope, as the TAD's Table 6 footnote 4 says, and is spoken as it is.
  - **Freshness:** sensors not heard from for 15 minutes are set aside. PurpleAir's `pm2.5_10minute` already "excludes
    downgraded channels", so a sensor whose two channels disagree is partly guarded. There is no A/B check of our own:
    it would need two more fields per row.
  - **Speech:** where and the category; then "AQI n, from k outdoor sensors within r kilometres, updated m minutes ago";
    "take it as a rough guide" with fewer than three near sensors; and one advice line above Good, from the TAD's
    Table 5. A place is said with its state or region (N2), unless geocoding showed it is in the household's own
  region and no other place shares its name; so a Rattlesnake Creek in Idaho, 175 km away, is never just "Rattlesnake
    Creek".
- **Here/home (YA-37).** This is deliberately not an area average. The service selects the nearest fresh, plausible
  outdoor sensor, then checks the 15 km ring before accepting it. If that closest reading wildly disagrees with the
  good sensors farther out, it is skipped and the next valid sensor is used. Its five-minute cache is separate from a
  named place's cache, so a home answer cannot accidentally reuse an area average.
- **Indoor (YA-37).** `AirQualityIndoorIntent` is slot-less and is allowed before account linking. The optional
  `IndoorSensorIndex` selects one PurpleAir indoor sensor directly; otherwise `IndoorSensorName` is matched exactly
  among `location_type=1` sensors near `HomeLocation` once per warm Lambda. The selected sensor is then read by index
  with `location_type=1`, and its fresh result is cached for five minutes. EPA cautions that an outdoor-collocation
  correction may not apply indoors, so the indoor figure uses the sensor's raw 10-minute PM2.5 rather than claiming
  that the EPA outdoor correction is valid there. It uses the same PurpleAir read-key parameter
  and existing `AirQualityPolicy`; no additional AWS permission or linked tracker account is needed. A key that cannot
  read that sensor produces the normal unavailable answer rather than exposing any identifier or credential.
- **Not AirNow's number.** It is a 10-minute sensor reading on the AQI scale. AirNow and its Fire and Smoke Map show a
  NowCast of hourly averages, and the TAD says the AQI proper is for longer exposures. While smoke is moving, the two
  can differ by a category. The guide says so too.
- **Caches, all in memory for the life of the execution environment.**
  - An area's figure: 5 minutes, per point rounded to two decimals (about 1 km). It stores the reading time, so a
    served answer's "updated N minutes ago" is recomputed. Past 15 minutes it is not served, and a new lookup can say
    "stale".
  - A name search's list of names: 1 hour. A named sensor's reading: 5 minutes.
  - Geocoder results: 24 hours per query, country and bias. The request says `IntendedUse: Storage`, as the reference
    requires when results are kept.
  - Failures are never cached.
- **Spending limits, per Lambda execution environment** (src/voice/air/limits.ts). The counters live in memory, so a
  new environment (after an idle spell, a recycle, or a concurrent request) starts again at zero; see the cost section
  for what that means in a day.
  - 20 lookups per speaker and 40 in all, per 10 minutes. Past either, "I've checked the air a lot just now. Try again
    in a few minutes.", and nothing is called.
  - At most 30 PurpleAir calls an hour and 150 a day, and at most 150 geocodes a day. Past a budget the answer is the
    same, and `air.budget.exhausted` is logged at warn once.
  - Every lookup writes one `air.usage` line in CloudWatch Embedded Metric Format. It becomes the metrics `Lookups`,
    `PurpleAirCalls` and `GeocodeCalls` in the namespace `YouTrackVoice/AirQuality`, with no API call or permission, and
    carries the hour and day counts.
- **The key.**
  - It is read from SSM with a 1 s limit that is also cut by the turn's signal, and kept for 15 minutes.
  - It is checked once per key value with `GET /v1/keys`. Anything but `api_key_type: READ` is refused, and logged at
    warn as `air.purpleair.keyType`, so a WRITE key pasted by mistake is never used. A check that fails (a timeout, a
    429, a 5xx) is not retried for two minutes. The check starts in the background when the service is built, so the
    first question rarely waits for it.
  - A PurpleAir response over 1 MB is refused, by its declared length or by counting the stream.
- **Time.**
  - PurpleAir calls time out at 2 s, geocoding at 1.5 s, and all are cut by the turn's signal.
  - The core passes the answer deadline (7 s after the request) to the service. Widening and the sensor search are
    skipped when less than 2.5 s remains.
  - An air-quality turn sends its progressive response ("One moment.") at 2.5 s rather than 5 s.
- **No link needed.**
  - With no usable credential, `AirQualityIntent`, `repeat`, `stop` and `cancel` reach the core. They get a tracker that
    refuses every call, and a state record of their own (`<speaker key>:unlinked`).
  - A number (`OpenIntent`) also does, but only as the very next turn after an unlinked air-quality answer, marked
    `airFollowUp` in the session attributes. That lets "one" answer a place choice; the turn after it has no mark.
  - On a linked record, a place choice replaces the issue list being heard, as a choice between people does, so "open
    two" after it picks a place. Say "my issues" to hear the list again.
  - Every other intent still gets the link prompt or the refusal, as before. The session's pin and time zone are carried
    through unlinked turns unchanged.
- **HOME_LOCATION never stops the skill.**
  - "lat,lon" and "lat lon" in range are a point; digits and hyphens are a postal code; other text is a place name.
    Codes and names are geocoded when first needed.
  - Anything else, such as coordinates out of range, is logged as `air.home.invalid` and ignored: there is then no home
    fallback, and every other intent works.
  - With `AirQuality=off` it is not read at all.
- **Logs.**
  - At info: outcomes, counts, radii, scores, decisions, timings, whether the device or home was used, and the AQI.
  - Never at info: the postal code (debug only), a place's words (debug only, as a slot value), coordinates, place or
    sensor names, sensor ids, or the speaker key used for the rate limit.
  - The PurpleAir key is never logged at any level; the tests hold a canary key to that.

### Decisions, and where the docs differ from the YA-36 brief

- **Geocoder: Amazon Location Service, Places API (v2) `Geocode`, not a place index and not Nominatim.**
  - The brief offered a place index (`SearchPlaceIndexForText`). Its reference page now says it "is no longer current
    and may be deprecated", and points to `Geocode`. `Geocode` needs **no resource in the stack**: the role gets
    `geo-places:Geocode` on `arn:aws:geo-places:<region>::provider/default`.
  - Nominatim's public service allows "an absolute maximum of 1 request per second", needs an identifying User-Agent,
    requires caching, and asks services built on geocoding to run their own server. Its ODbL attribution cannot be shown
    in a voice answer. A Lambda's shared outbound addresses would share that budget.
  - Places v2 is in the owner's own account and region, IAM-scoped, with no key to store.
  - `IntendedUse` is `Storage`, because results are cached for up to a day. That is the Stored rate, $4.00 per 1,000,
    not $0.50. At the 150-a-day cap it is at most $0.60 a day.
- **Slot type: AMAZON.SearchQuery** for `{place}`.
  - AMAZON.US_CITY "will be deprecated" in favour of AMAZON.City.
  - AMAZON.City is built for city names, but the slot must also carry postal codes and PurpleAir sensor names.
  - SearchQuery's rules are kept: every place sample has carrier words and holds no other slot, and the intent has one
    SearchQuery slot. "AQI" is written `a. q. i.`, as Amazon writes acronyms.
- **The correction is applied to cf_atm, not cf_1.**
  - PurpleAir documents `pm2.5_10minute` as "CF=1 for indoor and ATM variant for outdoor".
  - The AirNow Fire and Smoke Map applies EPA's extended correction (equation 4) to exactly that, "since 10-minute
    averages are not currently available for the cf_1 data".
- **PurpleAir key errors are 403, not 401.** 402 is no points left and 429 is the rate limit. All are spoken as "I
  couldn't reach the air sensors", and logged by kind.
- **EPA's Technical Assistance Document URL now serves the May 2026 edition** (EPA-403/B-26-003). The 2024 breakpoints
  are unchanged in it. The advice lines follow its Table 5 PM2.5 column for every category, quoted in
  `src/voice/core/phrasing.ts`.
- **The Device Address API page moved.** The older `device-address-api.html` is gone. The call and the scope are on "Use
  the Device Address" and the Device Settings API reference.
- **The consent card is off until the permission is declared.** "The permissions value always matches the scope that
  you declared for the skill on the Build > Permissions page". A card naming an undeclared scope is undocumented and
  may be rejected. So `AddressConsentCard` defaults to `off`, and the steps turn it on only after step 3.
- **[UNVERIFIED]** points to check:
  - The per-field API point costs: PurpleAir shows them only on the logged-in pricing tab. A call's base cost is 5
    points.
  - The point cost of `GET /v1/keys`.
  - How `MatchScores.Overall` is calibrated. The 0.8 and 0.5 thresholds are logged as `scores` on `air.geocoder.call`,
    for tuning.

### The steps

**Who:** Owner operates; the deploy is asked for first. **Sight:** screen reader, except the console permission (step
3), which is sighted once. Region `us-east-1`, stack `youtrack-voice`, **in bash**, as in the section above.

#### 1. Store the PurpleAir read key in SSM

Use the **READ** key, never the WRITE key. The skill checks the key type itself and refuses a WRITE key, but a WRITE
key should not be stored at all. It is pasted at a hidden prompt, reaches the AWS CLI on standard input, and is never
shown, typed on a command line or written to a file.

```bash
R=us-east-1
IFS= read -rsp "Paste the PurpleAir READ key (hidden), then Enter: " value; echo
[ -n "$value" ] && printf '%s' "$value" | aws ssm put-parameter --region "$R" \
  --name /youtrack-voice/purpleair/read-key --type SecureString --overwrite \
  --value file:///dev/stdin --query Version --output text
unset value
```

Expect a version number. `aws ssm get-parameter --region "$R" --name /youtrack-voice/purpleair/read-key --query
Parameter.Type --output text` prints `SecureString` without showing the value.

#### 2. Choose the home location

`HomeLocation` is where "air quality here" means when the Echo's postal code is not available. It is not a secret, but it
is a location: prefer a point at town level, two decimals, over the house itself. Any of these works:

- `46.87,-113.99` or `46.87 -113.99`: a latitude and longitude (no geocoding needed);
- `59802`: a postal code, geocoded when first used;
- `Missoula, Montana`: a place name, geocoded when first used.

Empty means no fallback: without the postal-code permission, "air quality here" then says it does not know where the device
is, and a town still works. A value the skill cannot read is logged as `air.home.invalid` and treated as empty. It never
stops the skill.

#### 3. Declare the postal-code permission (before any deploy)

**Who:** Owner. **Sight:** yes, once.

1. In the developer console, Build > **Permissions**, turn on **Device Country and Postal Code**. Leave **Device
   Address** (the full address) off. Save. In the skill manifest this is:

   ```json
   "permissions": [
     {"name": "alexa::person_id:read"},
     {"name": "read::alexa:device:all:address:country_and_postal_code"}
   ]
   ```

2. **Update the privacy policy** (runbook step 5):
   - Air quality sends the Echo's postal code, or the home location, to Amazon Location Service to find coordinates. It
     keeps the result in memory for up to a day.
   - It asks PurpleAir for the sensors in a box around them.
   - Neither the postal code nor the coordinates are stored in the state table or logged at the normal level.

#### 4. Deploy the Lambda (before the interaction model)

The new Lambda understands the old model (nothing sends `AirQualityIntent` yet); an old Lambda would answer the new
intent as unrecognised. So the Lambda goes first.

1. Record the live configuration, as in "Linking without the Alexa app", step 1.1:

   ```bash
   aws cloudformation describe-stacks --stack-name youtrack-voice --region us-east-1 \
     --query 'Stacks[0].Parameters' --output table
   aws lambda get-function-configuration --function-name youtrack-voice-alexa --region us-east-1 \
     --query '{h:Handler,m:MemorySize,t:Timeout,env:Environment.Variables}' --output json > /tmp/alexa-before.json
   ```

   The command below carries every live value, as the security review listed them on 2026-09-14, including
   `LinkBrokerSecretsEpoch=1` and `LinkBrokerOrigin=auto`. **If any value in the table differs from the command, stop
   and ask**: the command would change it.
2. Build both entries, exactly as in that section's step 1.2:

   ```bash
   npm ci
   rm -rf src/voice/alexa/deploy/.build
   npx tsc src/voice/alexa/deploy/lambda-entry.ts src/voice/link-broker/deploy/entry.ts \
     --outDir src/voice/alexa/deploy/.build/lambda --rootDir src \
     --module nodenext --moduleResolution nodenext --target es2022 --rewriteRelativeImportExtensions \
     --verbatimModuleSyntax --strict --skipLibCheck --types node
   echo '{"type":"module"}' > src/voice/alexa/deploy/.build/lambda/package.json
   ```

3. Deploy. The command is the linking section's, with only the last line added: `AirQuality=on`, the home location
   from step 2, and `AddressConsentCard=off`. **Replace `OWNER-MUST-CONFIRM-HOME-LOCATION` with the value chosen in
   step 2** (for example `46.87,-113.99`), keeping the single quotes around the double quotes so SAM receives the
   comma. Left as it is, it is only a place name that geocodes to nothing, so there is no home fallback.

   ```bash
   sam deploy --template-file src/voice/alexa/deploy/template.yaml --stack-name youtrack-voice \
     --region us-east-1 --capabilities CAPABILITY_IAM --resolve-s3 --no-fail-on-empty-changeset --on-failure DELETE --confirm-changeset \
     --parameter-overrides SkillId=<skill id> \
       EntryHandler=voice/alexa/deploy/lambda-entry.handler 'EnrolledPersonId=""' ReadAccepts=person,account \
       WriteAccepts=person AccountTokenFallback=true Cards=off EnrolmentLog=false LogLevel=info \
       YouTrackBaseUrl=https://example.youtrack.cloud YouTrackProject=H HouseholdLogin=Household_User \
       StateTtlDays=90 LogRetentionDays=30 \
       LinkBroker=on YouTrackClientId=alexa-voice-client \
       'YouTrackScope="<YouTrack service id> offline_access"' AlexaVendorId=<vendor id> \
       HouseholdHubUserId=<household Hub user id> SkillStage=development LinkBrokerAuthorize=off \
       LinkBrokerSecretsEpoch=1 LinkBrokerOrigin=auto \
       AirQuality=on 'HomeLocation="OWNER-MUST-CONFIRM-HOME-LOCATION"' AddressConsentCard=off \
       'IndoorSensorName="Susans Cir, High Meadows, Park City A"' IndoorSensorIndex=''
   ```

   Expect these in the changeset, and nothing else:
   - **`AirQualityPolicy` as Add**;
   - **`Function` as Modify**: new code and the air variables, including `INDOOR_SENSOR_NAME` and
     `INDOOR_SENSOR_INDEX`;
   - **`LinkFunction` as Modify**: new code from the same build folder.

   A change to `StateTable`, `LinkTable`, a role, a permission or a log group means stop and answer `n`.
4. Check that only the expected air variables changed:

   ```bash
   aws lambda get-function-configuration --function-name youtrack-voice-alexa --region us-east-1 \
     --query '{h:Handler,m:MemorySize,t:Timeout,env:Environment.Variables}' --output json | diff /tmp/alexa-before.json -
   ```

   Expect the existing values plus `AIR_QUALITY`, `HOME_LOCATION`, `ADDRESS_CONSENT_CARD`, `INDOOR_SENSOR_NAME` and
   `INDOOR_SENSOR_INDEX` as applicable.

**Turn it off** with the same command and `AirQuality=off`. The policy is removed, and the skill says "Air quality isn't
set up for this skill."

#### 5. Then the interaction model

As in "Recover, roll back, tear down": regenerate at the same commit, paste into Build > Interaction Model > JSON
Editor, Save, Build Model, and wait a few minutes.

```sh
node src/voice/alexa/generate-model.ts src/voice/core/intents.ts --invocation-name "issue desk" > model.json
```

Expect `AirQualityHereIntent` (slot-less), `AirQualityPlaceIntent` (one `place` slot of type
`AMAZON.SearchQuery`), and `AirQualityIndoorIntent` (slot-less). `AirQualityIntent` remains accepted by the Lambda
while the Alexa model transition completes.

#### 6. Grant the permission, and then the consent card

1. **Grant it** in the Alexa app: Skills & Games > Your Skills > Dev > issue desk > Settings > **Manage Permissions**.
   Turn on Device Country and Postal Code. **[UNVERIFIED]** the menu names; they move between app versions.
2. Optionally, so the Alexa app offers the grant whenever it is missing, run the step 4.3 command again with
   `AddressConsentCard=on`. This is safe only because step 3 declared the permission.
3. **If the app cannot grant it** (YA-14 found the app would not show the linking screen for this skill), nothing is
   broken. "Air quality" uses `HomeLocation` and says "at home", and "air quality in" a town always works.

#### 7. Try it

On the Echo, with the logs tailing (`aws logs tail /aws/lambda/youtrack-voice-alexa --follow --region us-east-1`):

1. "Alexa, ask issue desk for the air quality here". Expect "Air quality near you", or "at home" before the permission is
   granted. The logs show:
   - `alexa.link.notNeeded`, or the usual `alexa.request`;
   - `alexa.address`, with `outcome` `located` or `not-granted`;
   - `air.key.read` with `present: true`, then `air.purpleair.keyType` with `keyType: READ`;
   - `air.purpleair.call` with `rows`;
   - `air.lookup`, then `air.usage`.
2. Again within five minutes: `air.cache.hit`, and no `air.purpleair.call`.
3. "Alexa, ask issue desk what's the air quality in Missoula". Expect `air.geocoder.call` with `usable` and `scores`,
   and `air.lookup` with `decision: place-near`.
4. "...what's the air quality in Springfield". Expect "Did you mean ...?", then say "one".
5. Compare the figure with the PurpleAir map set to the **10 minute average** with the **US EPA** conversion. It should
   be close but not identical: this is a weighted median over a radius, not one sensor. Do not compare with AirNow's
   NowCast.
6. In CloudWatch > Metrics > `YouTrackVoice/AirQuality`, the three metrics appear within a few minutes.

**Failures, by log event:**
- `air.purpleair.noKey`: step 1 is not done.
- `air.purpleair.keyType` with `WRITE`: the wrong key is stored.
- `air.purpleair.refused` with `kind: key-refused`: a wrong or disabled key.
- `air.purpleair.refused` with `kind: points`: buy points.
- `air.geocoder.failed` with `AccessDeniedException`: the deploy did not add the policy.
- `air.budget.exhausted` or `air.limit`: the limits above were reached.
- `air.buildFailed`: the runtime lacks an SDK client. The answer is "I couldn't reach the air sensors".

**An alarm on abuse** (optional): a CloudWatch alarm on `PurpleAirCalls` (Sum, 1 hour) greater than 25, notifying the
Owner by email.

#### Rotate or remove the key

- **Rotate:** step 1 again with the new key. The function reads it again within 15 minutes, and checks its type; no
  deploy is needed.
- **Remove:** `aws ssm delete-parameter --region us-east-1 --name /youtrack-voice/purpleair/read-key`, then deploy with
  `AirQuality=off`.

### Cost of air quality, and the worst case

Prices: PurpleAir bought points are 100,000 per US$1 at the smallest tier, and new accounts start with 1,000,000 free
points. Amazon Location Stored geocoding is $4.00 per 1,000. PurpleAir's per-field point costs are **[UNVERIFIED]**;
this estimate assumes at most 2 points per field per row.

**The limits are per Lambda execution environment** (security recheck N1). Their counters are in memory, and nothing
stops Lambda from starting a fresh environment, with fresh counters, after an idle spell, a recycle or a concurrent
request. So the hourly caps are the real bound, and the "per day" caps only bound one environment's day.

**PurpleAir, per call:** 5 points, plus rows × fields × 2.

| Call | Fields | Rows, typical | Rows, pathological | Points, pathological |
| --- | --- | --- | --- | --- |
| Area, 5 km | 6 | 5 to 50 | 300 (the densest city) | 3,605 |
| Area, 15 km (only when 5 km had fewer than 3) | 6 | 5 to 30 | 2,000 (a sparse centre with a dense edge) | 24,005 |
| Name list, 15 km (cached 1 h) | 1 | 20 to 200 | 2,000 | 4,005 |
| Named sensors (`show_only`) | 6 | 1 to 5 | 5 | 65 |

**Worst hour, per environment**, with someone asking for new places without pause until every limit refuses:
- PurpleAir: 30 calls.
  - Every one a pathological 15 km box: 720,000 points, **$7.20**.
  - At a dense city's 5 km boxes: 108,000 points, **$1.08**.
- Geocoding: up to 150, all in that hour: **$0.60**.
- **Total:** about **$7.80 pathological**, and about **$1.70 realistic**.

**Worst day**, with environments turning over every hour, or one per hour of concurrency:
- PurpleAir: about **720 calls** (30 an hour for 24 hours).
  - Pathological: 17.3 million points, about **$173**.
  - Realistic: 2.6 million points, about **$26**.
- Geocoding: about **3,600 geocodes** (150 per fresh environment, each hour), **$14.40**, post-paid.
- CloudWatch: 3 custom metrics are about $0.90 a month. Lambda time and log lines are negligible.

**What stops it:**
- PurpleAir points are prepaid. At zero the API answers 402, and the skill says it couldn't reach the sensors. Keep
  the balance small.
- The skill is at development stage, so only the household's own devices reach it.
- **Set the alarm.** A CloudWatch alarm on `YouTrackVoice/AirQuality` `PurpleAirCalls` (Sum over 1 hour) above 25, or
  `GeocodeCalls` (Sum over 1 hour) above 50, emailing the Owner. For example, with an SNS topic the Owner has
  subscribed to:

  ```bash
  aws cloudwatch put-metric-alarm --region us-east-1 --alarm-name youtrack-voice-air-purpleair-calls \
    --namespace YouTrackVoice/AirQuality --metric-name PurpleAirCalls --statistic Sum --period 3600 \
    --evaluation-periods 1 --threshold 25 --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching \
    --alarm-actions <SNS topic ARN>
  ```

- Not done, and listed for later:
  - keeping the day counters in DynamoDB (one `air-budget#<date>` item with a conditional `ADD`, which needs
    `dynamodb:UpdateItem`);
  - a reserved concurrency on the skill function, which would also cap the tracker.

**Normal household use** (say 20 questions a day, most cached) costs a few thousand points and a few geocodes a day:
cents a month.

### Sources (checked 2026-09-14)

- **PurpleAir API v1** (doc version 1.0.15): https://api.purpleair.com/ (data file https://api.purpleair.com/api_data.js).
  - `GET /v1/sensors`: `X-API-Key`, `fields`, `location_type` (0 outside), `max_age` (default 604800 s), `show_only`,
    the bounding box, `pm2.5_10minute` ("ATM variant for outdoor", "excluding downgraded channels"), `confidence` (A
    and B channel agreement, 0 to 100), and `humidity` (inside the housing).
  - `GET /v1/keys` and `api_key_type`.
  - Error codes 402, 403 and 429.
- **PurpleAir API points:** https://community.purpleair.com/t/api-pricing/4523 and
  https://community.purpleair.com/t/how-do-i-calculate-my-api-calls-point-cost/8736
- **EPA US-wide correction** (Barkjohn et al., AMT 14, 4617-4637, 2021): https://amt.copernicus.org/articles/14/4617/2021/
- **EPA extended correction,** equation 4, applied to 10-minute cf_atm, and the NowCast display (AirNow Fire and Smoke Map
  Q&A, October 2021): https://document.airnow.gov/airnow-fire-and-smoke-map-questions-and-answers.pdf
- **Technical Assistance Document,** EPA-403/B-26-003, May 2026:
  https://document.airnow.gov/technical-assistance-document-for-the-reporting-of-daily-air-quailty.pdf, and the AQS
  breakpoint table, https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html. They cover:
  - the PM2.5 AQI breakpoints (2024 revision) and the truncation rule;
  - values above 500 (Table 6, footnote 4, and the FAQ);
  - the worked example (35.9 µg/m³ is AQI 102);
  - the sensitive groups (Table 4) and the cautionary statements (Table 5).
- **Device Address API:** https://developer.amazon.com/en-US/docs/alexa/custom-skills/use-device-address.html and
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/device-settings-api-reference.html
  - the country-and-postal-code call, and its 200, 204, 403, 429 and 500 responses;
  - the scope, the consent card, and "The permissions value always matches the scope that you declared".
- **Slot types** (AMAZON.City, the AMAZON.US_CITY deprecation, the AMAZON.SearchQuery rules):
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/slot-type-reference.html
- **Places API `Geocode`:** https://docs.aws.amazon.com/location/latest/APIReference/API_geoplaces_Geocode.html
  - `BiasPosition`, `IntendedUse` ("you must set this field to Storage"), `MaxResults` and `MatchScores`.
  - `GeocodeFilter` (`IncludePlaceTypes`, and `IncludeCountries` as alpha-2 or alpha-3):
    https://docs.aws.amazon.com/location/latest/APIReference/API_geoplaces_GeocodeFilter.html
  - IAM: https://docs.aws.amazon.com/location/latest/developerguide/security-iam-awsmanpol.html
  - Pricing: https://aws.amazon.com/location/pricing/
  - The legacy place index call:
    https://docs.aws.amazon.com/location/previous/APIReference/API_SearchPlaceIndexForText.html
- **Embedded Metric Format:**
  https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
- **Nominatim usage policy:** https://operations.osmfoundation.org/policies/nominatim/

## Recover, roll back, tear down

**Who:** Owner operates, asked first. **Sight:** screen reader.

- **A failed first create.** With `--on-failure DELETE` the stack deletes itself; fix the cause and run the step 2.3
  command again. If a stack is already in `ROLLBACK_COMPLETE` (a deploy without that flag), CloudFormation allows only
  deletion: `sam delete --stack-name youtrack-voice --region <region> --no-prompts`, then deploy again.
- **A failed update** rolls back to the previous working version by itself; `sam deploy` reports it. Read the reason
  with `aws cloudformation describe-stack-events --stack-name youtrack-voice --region <region> --max-items 20`.
- **Deploy order: Lambda first, then the interaction model** (YA-35 review F2). A new Lambda understands an old model:
  a list intent without the `person` slot behaves exactly as before. An old Lambda does not understand a new model:
  "what's assigned to Chris" arrives as a list intent whose `person` it ignores, and it reads *your* issues. So:
  1. Build and deploy the Lambda: the step 2.2 clean build, the step 2.3 command, the step 2.4 check.
  2. Regenerate the model at the same commit:
     `node src/voice/alexa/generate-model.ts src/voice/core/intents.ts --invocation-name "<name>" > model.json`.
  3. In the developer console: Build > Interaction Model > JSON Editor, paste `model.json`, Save, Build Model (step
     3.2). Wait a few minutes after the build before judging a device test.
- **Roll back: the interaction model first, then the code.**
  1. `git switch --detach <good commit>`, regenerate the model there (step 2 above), paste it, Save, Build Model, and
     wait for the build to finish.
  2. Then roll back the code: the step 2.2 clean build, then the step 2.3 command with the same parameters as now, all
     passed explicitly, then the step 2.4 check.
- **Tear down**, in this order:
  1. In the Alexa app: unlink, then disable the skill.
  2. In the developer console: delete the skill.
  3. In YouTrack: delete the OAuth client, which removes its OAuth access configuration.
  4. `sam delete --stack-name youtrack-voice --region <region>`. The state table and the log group go with the stack,
     intentionally (`DeletionPolicy: Delete`): nothing personal is left behind.
  5. Optionally, if nothing else in that region uses SAM: `sam delete --stack-name aws-sam-cli-managed-default
--region <region>` (empty its bucket first if SAM asks).
- **Rotate the client secret.** In YouTrack, open the OAuth client and click Change next to the Client secret; paste
  the new one into the skill's Account linking page and save. **[UNVERIFIED]** whether existing links keep working
  until their next refresh, or need relinking at once; check with step 8.5 afterwards.

## Cost

An **estimate** from public list prices (YA-14 operations review), not a quote, at about 100 turns a day:

- Lambda (512 MB, arm64, about 0.5 s a turn): cents a month, and inside the free tier where the account has it.
- DynamoDB on-demand (about 6,000 reads and writes a month): under $0.01.
- CloudWatch Logs at info (about 15 MB a month): under $0.01.
- SAM's artifact bucket: negligible.

Expected total: **under $1 a month**. The one open-ended cost is debug logging left on; step 2.4 shows the live level.
An optional alert at $5 a month:

```sh
aws budgets create-budget --account-id <account id> \
  --budget '{"BudgetName":"youtrack-voice","BudgetLimit":{"Amount":"5","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<email>"}]}]'
```

## Sources

All checked 2026-09-12. A page date is given where the page shows one.

- Request and response JSON: fields, `supportedInterfaces` as a map, the outputSpeech limit ("can't exceed 8000
  characters"), the card limit ("can't exceed 8000 characters") and the 120 KB response limit (page updated
  Aug 17, 2026).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html
- Request types: LaunchRequest, IntentRequest (`dialogState`, slots, `resolutionsPerAuthority`, ER status codes) and
  SessionEndedRequest reasons and error types (Nov 28, 2023).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-types-reference.html
- SSML: prosody rate "The minimum value you can provide is 20%" (no maximum stated), breaks up to 10 s, at most five
  audio files per response (Aug 28, 2025).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/speech-synthesis-markup-language-ssml-reference.html
- The 20-200% rate range, from Amazon Polly, used as the maximum:
  https://docs.aws.amazon.com/polly/latest/dg/prosody-tag.html
- SSML reserved characters: https://docs.aws.amazon.com/polly/latest/dg/escapees.html
- Sound Library (Aug 28, 2025), with paths and durations read from its published index `ask-soundlibrary._TTH_.json`:
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/ask-soundlibrary.html
- Progressive responses: `POST /v1/directives`, `VoicePlayer.Speak`, 204 on success, up to five, no Sound Library
  effects, and "approximately eight seconds" overall (May 29, 2024).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/send-the-user-a-progressive-response.html
- Device Settings API: `GET /v2/devices/{deviceId}/settings/System.timeZone` with `apiAccessToken`, 200 with an Olson
  zone; permission scopes are listed only for address information (Aug 01, 2024).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/device-settings-api-reference.html
- Regional API endpoints (`api.amazonalexa.com`, `api.eu.amazonalexa.com`, and `api.fe.amazon.com` for the Far East;
  the allowlist also admits `api.fe.amazonalexa.com`, which no checked page names):
  https://developer.amazon.com/en-US/docs/alexa/smapi/skill-messaging-api-reference.html
- Slot types: AMAZON.SearchQuery ("cannot be combined with another intent slot in sample utterances", "Each sample
  utterance must include a carrier phrase", one per intent), AMAZON.NUMBER, AMAZON.Ordinal and AMAZON.AlphaNumeric
  (Nov 28, 2023). https://developer.amazon.com/en-US/docs/alexa/custom-skills/slot-type-reference.html
- Standard built-in intents, including NavigateHomeIntent being handled by Alexa, and extending built-ins with samples
  (Oct 07, 2025). https://developer.amazon.com/en-US/docs/alexa/custom-skills/standard-built-in-intents.html
- Sample utterance rules (numbers as words, punctuation, possessives beside a slot) and unique samples across intents
  (Nov 28, 2023).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/create-intents-utterances-and-slots.html
- Interaction model schema (Aug 08, 2024):
  https://developer.amazon.com/en-US/docs/alexa/smapi/interaction-model-schema.html
- Custom slot type names, alphabetic characters and underscores:
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/create-and-edit-custom-slot-types.html
- Invocation name rules, English: no one-word names, the launch-phrase and connecting-word lists, wake words, periods
  in letter abbreviations, two-word names with articles or prepositions; "Computer" as a wake word on the Italian
  page (Mar 19, 2024).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/choose-the-invocation-name-for-a-custom-skill.html
- Personalization: `person.personId` and `person.accessToken`, the per-skill id, the Skill Personalization permission
  (`alexa::person_id:read`), the privacy policy, and "Personalization isn't authentication" (Jul 14, 2026).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/add-personalization-to-your-skill.html
- Account linking, authorization code grant, with PKCE using SHA-256 (Jul 14, 2026):
  https://developer.amazon.com/en-US/docs/alexa/account-linking/configure-authorization-code-grant.html
- Alexa redirect URL format `{baseUrl}/api/skill/link/{vendorId}` on pitangui, layla and alexa.amazon.co.jp:
  https://developer.amazon.com/en-US/docs/alexa/smapi/account-linking-schemas.html
- Lambda hosting: the `alexa-appkit.amazon.com` principal, skill id verification, and regions (Nov 7, 2025).
  https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-an-aws-lambda-function.html
- `AWS::Lambda::Permission` `EventSourceToken`:
  https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-permission.html
- Lambda Node.js runtimes (nodejs24.x deprecates Apr 30, 2028) and the bundled AWS SDK for JavaScript v3:
  https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html
- TypeScript on Lambda must be transpiled first: https://docs.aws.amazon.com/lambda/latest/dg/lambda-typescript.html
- `sam deploy` options `--on-failure [ROLLBACK | DELETE | DO_NOTHING]` (default ROLLBACK) and
  `--no-fail-on-empty-changeset`:
  https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-deploy.html
- YouTrack OAuth clients (2026.2): flows, Require PKCE, confidential client secret, redirect URIs.
  https://www.jetbrains.com/help/youtrack/cloud/oauth-clients.html
- Hub authorization code flow: `/api/rest/oauth2/auth` and `/token`, `access_type=offline`, `request_credentials`
  (`required` "logs out user and shows login form"), `code_challenge`, and Basic client authentication.
  https://www.jetbrains.com/help/youtrack/devportal/Authorization-Code.html
- Revoking tokens from Account Security: https://www.jetbrains.com/help/youtrack/cloud/manage-authentication-tokens.html
- DynamoDB item size limit (400 KB): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html

## Open questions

For review and for the owner.

- **OD1** is decided (household-wide reads, option B for this household); option A stays the code default. **OD2**
  (cards) is open, and cards stay off.
- **Fresh session records lose preferences.** When a session mixes tracker identities, the turn that starts fresh
  also starts with default verbosity and speech rate for that session record. Splitting preferences from the working
  set is a core change (YA-13), if the household trial shows it matters.
- **Relinking to a different YouTrack account** under the same Alexa holder is not detected by the tracker identity
  tag; the old record's list would be read under the new account until it expires. YA-15 does not close it (it logs
  the bound login and refuses a wrong account-level login); folding the login into the record is YA-28.
- **Late core turns.** The adapter refuses a timed-out turn's tracker calls and saves, and saves are conditional, but
  a guard cannot recall a request already on the wire. Since YA-15 the handler passes the turn's signal to the
  binding, which aborts YouTrack requests still in flight when the deadline fires.
- **PKCE, `access_type=offline` and `request_credentials=required`** are configured, not tested. Whether Alexa keeps a
  query string on the authorization URI is unverified; steps 8.3a and 8.5 make it an observed result.
- **AMAZON.AlphaNumeric** is public beta, and its handling of phonetic-alphabet words is unverified.
- **Custom skills on Alexa+** are unconfirmed, which is step 7's purpose.
