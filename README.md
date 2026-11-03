# youtrack-agents

YouTrack for coding agents: a dependency-free TypeScript CLI and client (`yt`), plus the agent instructions
(`AGENTS.md`) that make an issue tracker work with AI sessions, with every write stamped by the model and
session that made it, a placement vocabulary the owner uses with each request (backlog, current sprint, start
now), sprints with an explicit backlog, "things to check" hand-offs, and estimates and actuals in both hours and
tokens. Runs directly under Node 22.18 or newer (type stripping); no build step, no runtime dependencies.

## Quick start

In an existing repository, with a YouTrack project you administer and a permanent token for it:

1. **Add the tool** as a submodule:
   ```
   git submodule add https://github.com/soboko/youtrack-agents.git tools/youtrack
   ```
2. **Configure it.** Copy `tools/youtrack/.env.youtrack.example` to `.env.youtrack` at your repository's root,
   add `.env.youtrack` to `.gitignore`, and fill in the instance URL, project key, token and `YOUTRACK_OWNER`
   (the login that receives anything waiting on a person).
3. **Check the connection** and the project's fields:
   ```
   node tools/youtrack/yt.ts whoami
   node tools/youtrack/yt.ts fields
   ```
   Add whatever fields are missing from the list in `ADOPTING.md`.
4. **Point your agents at the rules.** Copy `tools/youtrack/templates/AGENTS-section.md` into your `AGENTS.md`
   (or `CLAUDE.md`) and fill in every `<...>`: instance and project, boards, the owner's login, what Fixed means
   for you, and your subsystems.
5. **Stamp every write.** Have whatever starts an agent session export `AI_MODEL` and `AI_SESSION_ID`.
6. **Look at the board:** `node tools/youtrack/yt.ts board`. `node tools/youtrack/yt.ts help` lists everything
   else.

**`ADOPTING.md` is the full checklist** for both sides: the YouTrack project's fields, states and boards, and the
host repository's configuration and agent instructions.

## Why this exists

For the past several months I have been quietly building something. I am not ready to say what it is yet.
Still, the *how* has become a story worth telling on its own, and this repository is one piece of it: the part
that keeps a single person and a crowd of coding agents pointed at the same work.

I have been ruthlessly capturing metrics along the way, and I do not think most people have internalized what
has only very recently become possible. The codebase stands at roughly 760,000 lines of first-party production
code, tests and executable specifications, on top of another 770,000 lines of open-source code pulled into the
tree and modified in place, not counting the libraries, packages and container images underneath. Around
3,200 git commits, none of them trivial. It spans more engineering specialties than any one person has, from
frontend and backend through data pipelines, graphics and infrastructure as code, the kind of breadth that has
always been the hard boundary between "side project" and "funded company with many employees". It even
includes an entirely new scripting language.

Against 2020-era engineering benchmarks, building it conventionally is somewhere around 55-65 person-years and
$12-15M fully loaded: at a 24-month deadline a team of roughly 30 across functions; at 12 months, 70 or more
people, most of them contractors you could not hire in time. Six months is no longer possible at any headcount,
because the critical paths do not parallelize.

I had wanted to build some version of it for 11 years, and parts of it could not have been done six years ago
at any cost. I started in earnest in February, made decent progress in a week, hit the ceiling of what the
models could do, and shelved it for four months. When the newest generation of frontier models arrived in July
the ceiling was no longer solid. Apart from that first week, all of it was built in the last four months.
Engineers hired: zero. Capital raised: zero.

What that pace exposes is a coordination problem nobody had before. Several agent sessions run at once, in
different worktrees, on different parts of the tree, some of them for hours. Each one reads the documents,
makes decisions, and leaves work in a state the next session has to pick up. The owner's day is spent
directing, reviewing and verifying, not typing, and the owner's attention is the scarce resource. Without a
shared record, the failure modes are immediate: two sessions doing the same thing, a fix that was made and
never verified, a document that says "not started" about something that landed a month ago, and no way to ask
"what is waiting on me?" This tool and its rules are the answer that emerged, and the numbers above are the
scale it was tested at.

### Agile for one person and many agents

The method is agile in shape and deliberately not agile in ceremony. The pieces:

- **The board is the only truth.** One kanban board, columns are the issue's State, swimlanes are the
  subsystem. There is no stage field, no separate status document, no chat thread to reconstruct. If it is not
  on the board, it is not happening.
- **Every write says who made it.** Issues carry the model and the session id that created them; every comment
  and work item ends with the same pair. "Who is on it" is answered by the tracker, not by memory, and a session
  id a person can open replaces the standup.
- **The owner speaks a three-word vocabulary.** Every concrete request comes with one of "add to backlog", "add
  to the current sprint" or "start now"; an agent that hears none of them asks before touching anything.
  Discussion is untracked until it becomes a plan. This is the whole intake process.
- **Sprints are the owner's attention window, not a team commitment.** The owner opens and closes them; agents
  file into the current one. The backlog is everything unresolved that is not on it. There is no sprint
  planning meeting, no velocity, no story points: a sprint is "what I intend to look at next", and it ends when
  the owner says so.
- **The human gate is Fixed to Verified.** Fixed means the agent has finished its work and handed it to the
  owner with a "Things to check" list: what to open, what to click, what correct looks like. State the branch,
  commit and whether it is merged or deployed; neither is a prerequisite for Fixed. The owner verifies, or reopens. Assignment means "waiting on": anything that needs a person is assigned to the
  owner, so "what is waiting on me?" is one query.
- **Estimates are calibration, not commitment.** Every issue carries what a senior developer with domain
  expertise would need, and what the agents actually took, in hours and in tokens, logged at each milestone.
  The point is the gap between the two, tracked over time; nobody is held to the estimate.
- **Documents and issues point at each other**, and a periodic audit round checks every document's open items
  against the code and the tracker, fixes stale statements in place, and leaves a dated verdict block. In a
  world where documents are written by sessions that no longer exist, the audit is the retrospective.
- **A recommended model per issue** records who should do the work: the strongest model for the hard and the
  already-expensive, a mid model for bounded features, a small one for mechanical edits, and "owner" for
  decisions and anything that needs a person with the device.

### How it differs from team agile

Team agile spends its ceremonies on the problems of humans working together: aligning understanding (planning,
refinement), surfacing blockers (standups), forecasting (points, velocity), and improving the team
(retrospectives). With one person and many agents most of those problems change shape or vanish:

| team agile | one person, many agents |
|---|---|
| a sprint is a time-boxed commitment the team forecasts and is held to | a sprint is the owner's attention window; it closes when the owner closes it |
| standup: humans report status to each other | identity stamps and milestone comments; status is read, not reported |
| story points and velocity forecast capacity | hours and tokens, estimate vs actual, calibrate the owner's expectations of the models |
| WIP is limited by developer capacity | WIP is limited by the owner's verification bandwidth; Fixed-awaiting-verification is the queue that fills up |
| definition of done is a team agreement | Fixed is the agent's handoff and Verified is one person's acceptance |
| refinement turns ideas into stories in a meeting | the three-word placement vocabulary does it in the sentence that makes the request |
| retrospective improves the team's process | the document audit improves the record the next session will read |
| roles: product owner, scrum master, developers, QA | one person is product owner, QA and the only reviewer; the agents are the developers, and they are replaceable mid-issue |

The differences all come from the same fact: the agents do not persist and do not coordinate among themselves,
so everything a team would carry in its heads has to be in the tracker and the documents, and the only
judgement that persists is the owner's.

### A hybrid: a small team plus agents

The same rules hold when a few people work alongside the agents; what changes is who plays the owner. A
reasonable arrangement:

- **Keep the board rules exactly.** State as the only stage, identity on every write, the placement vocabulary,
  Fixed as the agent's handoff. Humans file issues the same way agents do; a human's session id is their login.
- **Give each subsystem a human owner** who receives its "waiting on a person" issues and verifies its Fixed
  cards. The single-owner rule becomes an owner-per-swimlane rule, and "what is waiting on me?" stays one query
  per person.
- **Restore the ceremonies that are about humans**, and no others: a short planning session to decide what goes
  on the sprint and who owns what, and a review of the estimate-versus-actual figures. Standups stay retired;
  the tracker has the status.
- **Let humans do the verification agents cannot**: UI, feel, taste, anything with a device or an account. Let
  agents review agents everywhere else, as issues, with evidence in comments, so the human gate stays narrow.
- **Recommended model becomes recommended assignee**, with people in the list beside the models.

None of this needs a different tool. The tracker does not care whether the session id belongs to a person or
a model, and the rules were written so that it should not have to.


## Setup

1. Copy `.env.youtrack.example` to `.env.youtrack` at the root of the checkout (git-ignore it) and put a permanent
   YouTrack token in it, with the instance URL and project key. Worktrees and other checkouts that do not carry
   the file can use `~/.config/youtrack-agents/env` or `YOUTRACK_ENV_FILE=<path>`. Set `YOUTRACK_OWNER` to the
   owner's login: commands that hand work to the owner refuse without it. The optional variables name the main
   board, the board sprint commands default to, and the team group saved searches are shared with. The URL must
   be `https:` (plain `http:` only for localhost).
2. Check it: `node tools/youtrack/yt.ts whoami`.
3. Fields the rules expect on the project: `State`, `Subsystem` (an owned-field bundle: the swimlanes), `Type`,
   `Priority`, `Assignee`, `Estimation` (period), `Spent time` (period, computed from work items), `Token Estimate`
   and `Actual Tokens` (float, millions; existing values preserved), `AI Model` and `AI Session ID` (string), `Recommended model` (enum;
   `yt field add` creates it). `yt fields` shows what the project has.

## Identity: every write says which agent made it

The project has two string fields, **AI Model** and **AI Session ID**. `yt create` fills them from the agent's
identity, and every comment (`yt comment`, `yt cmd --comment`) and work item ends with the same pair:

```
---
_agent: claude-fable-5-1 · session: session_01AbCdEfGhIjKlMnOpQrStUv_
```

Identity comes from, in order: `--model` / `--session` flags, then `AI_MODEL` / `AI_SESSION_ID` environment
variables, then what the harness exposes (`CLAUDE_CODE_SESSION_ID`, `AI_AGENT`), then `unknown`. The harness
does not expose the model id, so **export `AI_MODEL` and `AI_SESSION_ID` at the start of a session**:

```
export AI_MODEL=claude-fable-5-1 AI_SESSION_ID=session_01AbCdEfGhIjKlMnOpQrStUv
```

For a Claude Code agent the session id to use is the `claude.ai/code/session_...` id from the attribution
reminder (a person can open that one), not the local UUID.

## The board

The kanban board has **State** as its columns and **Subsystem** as its swimlanes. State is the single source of
truth for where an issue is; moving a card is `yt state PRJ-12 'In Progress'`. The recommended columns, in order:
Submitted | Open, Reopened | In Progress | To be discussed | Fixed | Verified | closed (Won't fix, Duplicate, Can't
Reproduce, Incomplete, Obsolete). A project may run a second board restricted to some swimlanes. Every issue
needs a Subsystem (`yt subsystem PRJ-12 'Map Client'`, or `--subsystem` on create). `yt fields` prints every
field with its allowed values; values are matched case-insensitively and a wrong value fails before anything
is sent.

## Commands

| command | does |
|---|---|
| `yt whoami` | token check; prints the identity that will be stamped |
| `yt fields` | project fields, types, allowed values |
| `yt field add 'Name' --values a,b,c [--empty text]` | a global single-value enum field (bundle + prototype), attached to the project; idempotent, adds missing values |
| `yt board [--board 'Name']` | unresolved issues grouped by kanban column (State), up to 500; stderr says when more exist |
| `yt list [query] [--top N]` | YouTrack query, scoped to the project: `yt list 'State: Open'`, `yt list '#Unresolved Type: Bug'`; stderr says `(showing N; more exist: raise --top)` when capped |
| `yt show PRJ-1` | fields, description, comments |
| `yt create --summary S --subsystem 'Map Client' --recommend claude-sonnet-5 --role Builder [--description-file F] [--type Task] [--priority Normal] [--state Open] [--set 'Field=Value']` | new issue; AI Model / AI Session ID filled in; `--subsystem`, `--recommend` (the model) and `--role` (who acts next) are required; default state is Submitted |
| `yt take PRJ-n` | In Progress, on the current sprint of every board that runs one, assigned to the API user; prints the Role to adopt. Refuses an issue that is with an Owner role (`--force` to override) |
| `yt handoff PRJ-n 'Owner decides' 'note'` (or `--file F`, `[--state S]`) | sets Role, posts the *Hand-off to* note (the pick-up spot), assigns the owner for Owner roles and unassigns for agent roles |
| `yt state PRJ-1 'In Progress'` | State = the board column |
| `yt state PRJ-1 Fixed --check 'text'` / `--check-file F` | move to Fixed and post the "Things to check" comment for the owner (required for UI changes and anything tests do not cover; see AGENTS.md) |
| `yt subsystem PRJ-1 'Map Client'` | Subsystem = the swimlane |
| `yt subsystems` / `yt subsystems add 'Name' --description '...'` | list, or add a subsystem to the field AND the board's swimlanes (one without the other leaves cards uncategorized) |
| `yt assign PRJ-1 login` / `none` | assignee |
| `yt set PRJ-1 'Priority=Major' 'Estimation=2h'` | any fields by name; `'Field='` clears |
| `yt edit PRJ-1 --summary S --description-file F` | summary and description |
| `yt comment PRJ-1 'text'` / `--file F` / `-` (stdin) | Markdown comment, annotated |
| `yt estimate PRJ-1 --time '2d 4h' --tokens 20M` | Estimation (senior developer with domain expertise) and Token Estimate |
| `yt actual PRJ-1 --time 1h30m [--type Implementation] [--note '...']` | logs a work item; token increments require an atomic-accounting provider and are refused by the current YouTrack adapter |
| `yt work PRJ-1` | logged work items |
| `yt cmd PRJ-1,PRJ-2 'State Fixed Priority Major' [--comment C]` | YouTrack command language, the same strings the UI's command box takes |
| `yt sprints [--board B]` | the board's sprints and which is current; sprint commands default to the the sprint board, `--board 'the main board'` for the main one (both run sprints) |
| `yt sprint add PRJ-1,PRJ-2 'Sprint 1'` | put issues on a sprint (membership is explicit, set through the command language `Board <board> <sprint>`) |
| `yt sprint create 'Sprint 2'` / `rename 'a' 'b'` / `enable` / `disable` / `backlog 'query'` | the owner's sprint housekeeping; agents only `add`. The backlog is a saved search, shared with the the project's team group group (the API user's searches are private otherwise) and attached as the Agile's top-level `backlog` |

Long text: write Markdown to a file and pass `--description-file` or `--file`; `-` reads stdin. `--json` makes
read and native commands print provider objects instead of text. Workflow commands (`create`, `take`,
`handoff`, `state`) return a versioned result envelope; see [architecture and compatibility](docs/architecture/overview.md).
`--quiet` drops the request log on stderr. Transport errors redact credentials and do not echo response bodies.


## From TypeScript

```ts
import { createClient } from './client.ts';
import { resolveIdentity } from './identity.ts';

const yt = createClient(resolveIdentity({ model: 'claude-fable-5-1', session: 'session_...' }), { log: console.error });
const issue = await yt.createIssue({
  summary: 'Tile seam at zoom 14', fields: { Type: 'Bug', Priority: 'Major', Subsystem: 'Tile Server' },
});
await yt.addComment(issue.idReadable, 'Reproduced on staging; see `docs/...`.');
await yt.setState(issue.idReadable, 'In Progress');
const open = await yt.listIssues('State: Open');
```

`client.ts` exports `YouTrackClient` (`createIssue`, `getIssue`, `listIssues`, `updateIssue`, `setFields`,
`setState`, `setSubsystem`, `addSubsystem`, `swimlanes`, `boardColumns`, `assign`, `addComment`, `comments`,
`setEstimate`, `addActual`,
`logWork`, `workItems`, `command`, `fields`, `whoami`, `request` for anything else) and `YouTrackError` (status
on failure; the response body is omitted). Field values are given by **name** (`State: 'Open'`,
`Assignee: 'agent-bot'`); the client looks up each field's type and builds the `$type` the API wants.


## Estimates and actuals

Four numbers per issue, rules in `AGENTS.md` (this directory) "Estimates and actuals". In short: `Estimation` is the time a senior
developer with domain expertise in that code would need, `Token Estimate` the expected agent spend, and the
time actuals accumulate through `yt actual` at every milestone. Token increments are currently refused because
the YouTrack adapter cannot guarantee atomic, retry-safe accumulation. Mixed time/token requests write nothing;
log time separately and record token estimates in milestone comments. See the [accounting contract](docs/architecture/accounting.md). `Spent time` is computed by YouTrack from work items
and cannot be set directly; periods use YouTrack's form (`45m`, `1h30m`, `2d 4h`, 8 h days, 5 d weeks). Token fields
are floats in **millions** (25 = 25M, 0.2 = 200k) so cards and column totals stay short; the tool accepts `25M`,
`250k`, `1.5M` or a raw count and prints them the same way. A bare number under 1000 is read as millions.


## Gotchas seen so far

- A board created through the API belongs to the API user and is visible only to it until `readSharingSettings`
  and `updateSharingSettings` are set to `projectBased` (and ideally the owner is changed to a person). It also
  comes with sprints ENABLED and explicit membership, so it shows no cards until `sprintsSettings.disableSprints`
  is true, as on a board created in the UI.
- A Subsystem value that is not also in a board's swimlane list puts its cards in "Uncategorized Cards";
  `yt subsystems add` does both for the main board. A second board keeps its own lane list.
- `Spent time` cannot be set; it is the sum of work items. Use `yt actual --time`.
- Enabling sprints on a board needs `sprintsSettings.isExplicit: true` (or a sync field) in the same write, or the
  board reports "The setting that links sprints to a custom field is undefined" and refuses every command. The
  first write that flips it can come back as an empty 400 while still applying; a repeat is clean. `yt sprint
  enable` sends both.
- Several values of one field in a query is a comma list, `Subsystem: {Map Client}, {Tile Server}`;
  `(Subsystem: {A} or Subsystem: {B})` parses but matches nothing, which showed up as an empty backlog.
- The backlog panel did NOT hide current-sprint cards on its own here; the saved searches say it explicitly with
  `Board <board name>: -{Current sprint}`, which follows the current sprint as the owner rolls them, so the query
  never needs editing. `Board <name>: {Sprint 1}` (braces round a name with a space) lists a sprint's cards.
- A board's backlog is the Agile's top-level `backlog` (a SavedQuery); writing it under `sprintsSettings` is
  silently ignored. A saved search created by the API user is private to it until its `readSharingSettings` /
  `updateSharingSettings` name a group, and the owner then sees "This board doesn't have a backlog".


## Development checks

```sh
npm ci
npm test
npm run typecheck
npm run format:check
```

Tests use local fixtures, fake tracker ports and fake HTTP transports. They do not require a live tracker
or credentials. Formatting uses the existing 120-column Prettier configuration. Read and reposition comments
after formatting: an explanation belongs beside the operation it describes, not on a distant closing brace.

## Conventions

Code here is Prettier-formatted (120 columns, config in `.prettierrc.json`) to a condensed form of Google's
TypeScript style guide, and prose — comments, docs, commit messages — uses UK/Canadian spelling and idiom
(colour, centre, behaviour, ...). Both were deliberate, early decisions, not defaults nobody chose. If you
fork this or adapt it for your own project, pick whichever conventions you like — just pick one early and
stick with it, rather than letting it drift by accident the way ours nearly did.

## Licence

MIT; see [LICENSE](LICENSE).
