# Working with YouTrack as a coding agent

These are the rules for an AI coding agent (Claude Code, Codex, or similar) that tracks its work in a YouTrack
project with the `yt` tool in this directory. They are project-independent. The project that uses them supplies,
in its own agent instructions: the instance URL and project key, the board names, the list of subsystems and how
to choose one, the owner's login, what Fixed means there, and where its task documents live. `ADOPTING.md` says
how to set both sides up and `templates/AGENTS-section.md` is the block the host fills in. Everything below
assumes those are known.

## Identity on every write

Export these at the start of a session so every issue, comment and work item is stamped:

```
export AI_MODEL=<model id>          # e.g. claude-fable-5-1, gpt-6
export AI_SESSION_ID=<session id>   # an id a person can open; for Claude Code, the claude.ai/code/session_... id
```

Issues get the `AI Model` and `AI Session ID` fields from them; comments and work items end with an annotation
line naming both. A write without them is stamped `unknown` and will be asked about.

## What gets tracked, and when

Not everything the owner says becomes an issue. The rule is about the kind of request, not its size.

- **A concrete request that touches code, assets or documents** ("fix X", "add Y", "change the Z") is tracked.
  The owner is expected to say one of three things with it:
  - **"add to backlog"**, optionally with a rough priority: file the issue in Submitted with that Priority, on no
    sprint; do not start.
  - **"add to the current sprint"**: file the issue in Open and put it on the current sprint of every board that
    runs sprints (`yt sprint add PRJ-n 'Sprint N' [--board B]`); do not start.
  - **"start now"**: file the issue in In Progress, put it on the current sprint, and begin. "Start now" always
    implies the current sprint.

  **If the owner says none of these, ask where it should be placed before doing any work.** Do not guess, and do
  not start a concrete change untracked.

  The question has THREE answers, not two: an existing issue, a new issue, or not tracked. Asking "shall I file
  an issue?" and hearing "no" does not mean untracked — it usually means it belongs to something already open.
  **Naming the issue yourself is the failure mode.** An agent deep in a task acquires an issue it is already
  working under, and every follow-on change gets attributed to it because that is the id in hand — including
  work plainly outside its summary. The issue then stops describing what was done to it, its "Things to check"
  misleads the owner about what to look at, and the board loses the new work entirely. If the next change is not
  obviously the issue you are in, **stop and ask which issue it belongs to**; one line from the owner is cheaper
  than a ticket that has to be unpicked.

  **Finding out whether an existing issue covers it.** The three answers are no use without a way to check the
  first one, and the check has to be cheap or it will not be done. **List the subsystem and read it:**

  ```
  yt list "Subsystem: {<the subsystem the request belongs to>}" --top 500
  ```

  One call, always current, and one line per issue with its id, state and summary. If stderr says `more exist`,
  the subsystem has more than 500 issues: raise `--top` until it does not. Include the resolved ones:
  "do we have a ticket for this" often means "was this already done". Measured on a 346-issue project, one
  subsystem came to 109 issues, 12 KB, about **three thousand tokens** — less than one confused round-trip
  costs, so read all of it and judge the near-matches yourself rather than skimming for keywords.

  **Do not rely on a text search for this.** YouTrack's full-text matching is loose and ranks badly. Searching
  `chevron` inside a subsystem returned theme settings, an unrelated stress-test issue and a module-refactor
  issue — none about chevrons — while missing the actual chevron work. It gives false positives and misses at
  once, and an agent that trusts it both files duplicates and attributes work to issues that do not cover it,
  which is the failure mode above. Use a search to jump to something you already know exists, not to establish
  that nothing does.

  **Do not build a committed index file.** It is the intuitive fix and it is worse: a shared file carrying
  mutable state is stale the moment anyone touches the tracker, conflicts across branches and worktrees, and
  needs regeneration discipline nobody keeps. The listing above has none of those failure modes and costs the
  same to read.
- **Ideas, thoughts and discussion** are not tracked. Talk freely; no issue, no document, no card. That changes
  the moment it turns into a plan: if the owner asks for a written summary, write it and file an issue for it;
  if the owner asks for work to start, file the issue and start.
- **Non-code work is tracked like any other**: a licensing question, a document to write or correct, a help page,
  a piece of marketing copy is an issue in its subsystem, filed when it is noticed.
- **A task document** (a packet, a plan, a handoff) always has an issue: the issue's description carries the
  document path and the document names the issue id near its top. When one is created after the other, update
  the older one in the same change. A document with no issue id, or an issue with no path, is unfinished.
- **Standing order: when creating an issue for something an existing document already describes** (a known
  defect in an architecture note, an entry in an open-issues list, a risk in a packet, an open item in a handoff),
  add the issue id to that document in the same step and cite the document in the issue. Creating the issue is
  not finished until the document points back at it.

## The board must match reality

**A change in the work is a change on the board, in the same step.** The board is how the owner sees what is
happening; an agent that works without moving cards leaves them looking at a lie. This is not bookkeeping to do
at the end — it is part of starting, and part of stopping.

- **Before the first edit**, the issue you are working is `In Progress`, assigned to you, and on the current
  sprint of every board that runs one. `yt take PRJ-n` does all three. Not after the first commit, not when you
  report back: before you touch anything.
- **This applies however you came by the issue.** Told to take one, asked to "pick something to work on", or
  chose it yourself from the board — the obligation is identical. Choosing your own issue is the case most
  often missed, because nobody handed you an id and it feels like browsing rather than starting.
- **Every state you enter, you say so.** Handed to another role goes through `yt handoff`. Abandoned goes back
  to `Open` with a comment saying how far it got — an issue silently left in `In Progress` is worse than one
  never taken, because it reads as someone still on it.
- **Finished means `Fixed`, assigned to the owner, with the "Things to check" list.** Fixed is the agent's
  hand-off, not the owner's acceptance: it says *I have done what I can, it is your turn*. Do NOT wait for a
  merge, a deploy, or anything else outside the work itself — say in the comment where the change is (which
  branch, whether it is merged, whether it is deployed) and let the owner decide what to do with it. `Verified`
  is theirs to set.
- **Blocked on a person means `In Progress`, assigned to the owner, with the questions written down.** A task
  that cannot finish without human input is not finished and must not be marked Fixed; nor is it abandoned. Put
  the questions in a comment — numbered, each answerable in a line — assign the owner, and leave the state
  saying what is true: still in progress, waiting on them. Do everything that does NOT depend on the answer
  first, so what is waiting is only what genuinely has to.
- **Work that outgrows its issue gets its own.** If what you are doing no longer matches the summary, stop and
  ask (see above) rather than widening the issue under the owner.
- **If you cannot reach YouTrack, say so in your reply.** An unreachable tracker is a fact the owner needs, not
  a reason to work untracked and reconcile later.
- **A failed `yt` command may still have written.** A workflow, native or admin command that fails after a write
  reports `partial` or `unknown` rather than `rejected`, with its `applied`, `pending` and `uncertain` steps or a
  count of confirmed writes. Read the issue and reconcile before re-running it; re-running on `unknown` can
  duplicate a comment, a work item or a sprint.

## Commit messages carry the issue state

Every commit an agent creates, including an explicit merge commit, must put the
issue id and the issue's current YouTrack state in the subject in this exact
bracket form:

```text
[PRJ-13, Fixed] concise description of the change
```

- Read the issue immediately before `git commit` and copy its id and State
  exactly; the bracket records the state **when the commit is created**, not the
  state the agent expects to set later.
- The normal implementation sequence therefore produces a subject such as
  `[YA-1, In Progress] Require issue state in commit messages`, then pushes the
  commit, and only afterward moves the completed issue to Fixed. Never move an
  issue early merely to put `Fixed` in the commit message.
- If one commit intentionally belongs to more than one issue, include one
  bracket for each issue in the subject, each with its own current state. Do not
  use a multi-issue commit to avoid the rule that independently useful work gets
  independently tracked.
- If work was explicitly authorized as untracked but later needs a repository
  commit, stop before committing and have the owner assign or create an issue.
  An agent cannot create an untracked commit because there would be no truthful
  issue-and-state bracket to put in its subject.
- A fast-forward creates no commit and needs no new message. When an agent does
  create a merge commit, its subject follows the same rule and names the issue
  or issues being integrated.
- If YouTrack cannot be reached, do not guess the state and do not create the
  commit. Report the tracker outage and leave the changes uncommitted until the
  current state can be read.

## Board and workflow

The kanban board's columns are the `State` field, the single source of truth for where an issue is; its
swimlanes are `Subsystem`. There is no separate stage field. Move a card by setting State
(`yt state PRJ-n 'In Progress'`). The recommended state set:

| column | State values | means |
|---|---|---|
| Submitted | Submitted | filed by an agent or a report; not yet triaged |
| Open | Open, Reopened | triaged and accepted |
| In Progress | In Progress | someone is working on it; reviews and verification are comments here, not columns |
| To be discussed | To be discussed | blocked on an owner decision; the comment says which |
| Fixed | Fixed | the agent is done; assigned to the owner to verify. Still unresolved — Fixed is a hand-off, not an acceptance |
| Verified | Verified | owner accepted; the first resolved state on the happy path |
| closed | Won't fix, Duplicate, Can't Reproduce, Incomplete, Obsolete | closed without a fix; the comment says why |

Milestones inside In Progress (review assigned, verification running) are comments with evidence.

## Sprints

Boards run in sprints named `Sprint 1`, `Sprint 2`, ... Membership is explicit: an issue is on a sprint because
someone put it there (`yt sprint add`); `yt sprints` lists a board's sprints and which is current.

- **The backlog is "anything unresolved that is not on the current sprint".** Each board's backlog panel is a
  saved search of the project's unresolved issues excluding the current sprint (`Board <board>: -{Current sprint}`,
  set with `yt sprint backlog`). A Submitted issue is never put on a sprint, so it is always in the backlog.
- **Everything not Submitted lives on the current sprint.** When an issue leaves Submitted it goes onto the current
  sprint of every sprint-running board in the same change, unless the owner names a different one. **Closing counts
  too:** `yt state` to Verified, Won't fix, Duplicate, Obsolete or any other closed state also puts the issue on the
  current sprint, even one that sat on an earlier sprint, so each sprint shows what was closed during it. This is
  the owner's decision, not an accident of the tool; do not work around it with `yt cmd`.
- **The owner closes the current sprint and opens the next.** Agents do not create, close or archive sprints
  (`yt sprint create` exists for the owner's convenience); they file into the current one.
- **Between sprints** (a sprint-running board with no active current sprint), `take`, `state`, `handoff --state`
  and `create --state` still apply their changes and report `partial` with `place in <board>: no current sprint`
  pending. Nothing needs reconciling; do not re-run the command. If you are still on the issue once the owner
  opens the sprint, put it there with `yt sprint add PRJ-n 'Sprint N'`.

## Moving to Fixed: the "Things to check" comment

When an issue moves to Fixed and needs a person to verify it, add a comment headed **Things to check** in the
same step: every UI issue, and any non-UI issue the existing tests cannot verify on their own. It is a short
checklist for the owner, who filed the issue and has the context: what to open (a URL with its port, when there
is one), what to click or run, what the correct result looks like, and which commit or deploy it applies to.
Three to six lines is normal. `yt state PRJ-n Fixed --check 'text'` (or `--check-file F`) posts it, assigns the
owner and sets Role to Owner verifies: it is the hand-off to the person who checks. An issue whose fix is fully
covered by tests that ran (say which, in the Fixed comment) does not need the list; `yt state ... Fixed` without
`--check` prints a reminder on stderr (not with `--quiet` or `--json`) and goes ahead, and still assigns the owner
and sets Owner verifies.

## Assignment: the owner holds anything waiting on a person

Assignee says who the issue is waiting on. When an issue reaches a state where a human has to act, assign it to
the owner: every Fixed issue that needs verification, everything in To be discussed, and anything blocked on a
decision only the owner can make. When an agent picks the issue back up, it assigns itself. `yt state ... Fixed
--check` and `yt state ... 'To be discussed'` assign the owner automatically; anything else is `yt assign PRJ-n
<owner login>`. The owner's login comes from `YOUTRACK_OWNER`: without it `yt whoami` shows `owner: admin
(default)`, and every command that would assign the owner refuses and writes nothing, rather than hand the issue to
a placeholder login. Role says which kind of person-work it is waiting on (see "Role"); `yt handoff` sets both.

## Estimates and actuals: time and tokens

Every issue that reaches development carries four numbers, and its task document repeats them at milestones:

| field | rule | how |
|---|---|---|
| `Estimation` | the time a **senior developer with domain expertise in that code** would need, not the agent's expectation of itself | `yt estimate PRJ-n --time '2d 4h'`; set once when planning, revised only with a comment saying why |
| `Token Estimate` | expected agent token spend across all sessions on the issue, including reviews; stored in millions so cards read `25` not `25000000` | `yt estimate PRJ-n --tokens 20M` (also `250k`, `1.5M`, or a raw count) |
| `Spent time` | actual agent wall-clock time, summed by YouTrack from work items; never set directly | `yt actual PRJ-n --time 1h30m --type Implementation --note '...'` at each milestone |
| `Actual Tokens` | actual agent tokens in millions; not writable through the YouTrack adapter (refused; see below) | record the token estimate in the milestone comment |

**Provider capability:** the current YouTrack adapter refuses token increments because its documented API
cannot guarantee an atomic increment or deduplicated retry. A mixed time-and-token request is rejected before
logging time. Log time separately; record estimated token usage and the unsupported capability in the milestone
comment. Do not bypass the refusal with a raw field read–modify–write or claim the total was updated. Existing
totals remain unchanged. See `docs/architecture/accounting.md` (YA-12).

Log actuals at every milestone comment, not once at the end, so an abandoned or handed-off issue still has a
record. Where a figure is approximate, say so in the note. The point of the pair is to compare the
senior-developer estimate with what the agents actually took, so never tune the estimate toward the actual.

## Recommended model

`Recommended model` (a single-value enum of model ids plus `owner (no model)`) says who should do the work.
**Every new issue is filed with it**: `yt create` requires `--recommend <model id>` and refuses without it, so
an issue never sits in the backlog with nobody sized for it. Revisit it when the issue is planned or goes on a
sprint, and say why in a comment when the choice is not obvious. The bands: the strongest model for rendering, geometry, concurrency,
intermittent bugs and anything that has already cost rounds; a mid model for well-bounded features and fixes; a
small model for settings, copy and mechanical edits; `owner (no model)` for decisions, reviews and anything that
needs a person with the device or the account. An issue in Fixed carries the model that did the work, for any
rework. `yt cmd PRJ-n,PRJ-m 'Recommended model claude-opus-5'`. Create the field with
`yt field add 'Recommended model' --values '<model ids>,owner (no model)'`.

## Role: who acts next

`Role` (a single-value enum, required on every issue) names the persona that acts next on the issue, or that the
issue is waiting on when nothing is moving. Assignee stays the specific login; Recommended model stays the model;
Role is what the model, or the person, is being when they pick it up. Eleven values, broad-grained:

| Role | who | the persona |
|---|---|---|
| Director | agent | plans and splits: the packet, the subtasks, worktrees and ownership, launching builders; epics and architecture packets start here |
| Builder | agent | owns the change in its worktree: code, tests, docs, commit, push; the default for features and bugs |
| Reviewer: correctness / security / testing / operations / product | agent | reads the branch adversarially from a clean worktree and never fixes it; the kind says which review the host's matrix asked for |
| Judge | agent | adjudicates when reviewers disagree or a P0/P1 is disputed; named so it is never silently skipped |
| Owner decides | human | a product, design or cost decision is needed before anyone can continue |
| Owner verifies | human | a by-eye or on-device check of something built |
| Owner operates | human | a real-world action only a person can take: a production deploy, credentials, spending, a physical device |

Rules:

- **Set at creation** (`yt create --role ...`, required). Features and bugs start as Builder; epics and packets as
  Director; a question as Owner decides. An issue created with an Owner role is assigned to the owner at once.
- **Changes only at a hand-off**, and every hand-off leaves a **pick-up note**: `yt handoff PRJ-n '<role>' 'note'`
  sets the Role, posts a comment headed *Hand-off to <role>* with the note, assigns the owner for the three Owner
  roles and unassigns for agent roles. The note says what the next role has to do and where things stand: the
  branch and commit, what was verified, the decision needed, the blocker. That comment plus the Role value is the
  pick-up spot; an issue left idle without them is unfinished.
- **The two person-states set it for you:** `yt state ... Fixed --check` makes it Owner verifies, `yt state ...
  'To be discussed'` makes it Owner decides. Both are hand-offs in all but name.
- **Never hand off to `Owner verifies` on its own.** That role IS the finished hand-off, and finished means
  `Fixed` with the "Things to check" list: `yt state PRJ-n Fixed --check '...'` sets the state, posts the list
  and assigns the owner in one step. `yt handoff PRJ-n 'Owner verifies' '...'` refuses for that reason — on its
  own it leaves a finished issue sitting in `In Progress`, reading as though an agent is still on it. If the
  work is not finished because it is waiting on a person, that is the `In Progress` + owner + numbered
  questions case above, not this one.
- **Taking an issue adopts the persona.** `yt take PRJ-n` moves it to In Progress on every board's current sprint,
  assigns you, and prints the Role: read that role's file (the host's AGENTS.md maps each agent role to one) before
  touching anything, and act as it. An issue whose Role is an Owner role is not takeable: it is waiting on a person,
  and the hand-off note says what for; `--force` exists for the owner delegating it back.
- **The frequency of assignment does not change.** This is not a ticket-routing system; most issues go Builder,
  then Owner verifies, then done. The field earns its keep on the ones that stall: a query for `Role: {Owner decides}`
  or `Role: {Reviewer: security}` on unresolved issues is a queue with nothing hidden in it.

## "Take an issue and start work"

When the owner asks for an issue to be picked up without naming one — *"take an open issue and start work"* —
take the **top Open issue on the current sprint whose `Recommended model` is the model you are and whose `Role`
is an agent role**, `yt take` it (In Progress, on the sprints, assigned to you), read the role file the Role
names, and begin. Do not ask which; that is the point of the phrasing.

- **Open, on the current sprint.** Submitted is the backlog and nobody has triaged it; In Progress is already
  someone's. `Recommended model` is what makes the queue yours rather than everyone's, so an issue recommended
  for a different model is not yours to take even when it is top of the list.
- **"Top" is the board's order**: Priority first, then position within the sprint. Say which one you took and
  why it was top, so the owner can redirect in one line if the ordering was not what they had in mind.
- **If nothing matches**, say so rather than taking the nearest thing — an empty queue for your model is
  information the owner wants, and it usually means the sprint needs `Recommended model` set on something.
- Then work it normally: comments at milestones, actuals logged, `Fixed` with a "Things to check" list.
- **A looser ask is the same obligation.** *"Pick something to work on"*, *"find an opus-level task"*, *"what's
  next"* — all of them end in `yt take` before the first edit, and in saying which issue you took. An agent that
  picks an issue, works it and reports back without the card ever moving has left the board describing a state
  that was never true.

## Where a new rule goes

When the owner adds or changes a rule about working with YouTrack, decide first whether it is
**project-independent** (it would hold for any project using this tool: identity, placements, states, Fixed,
estimates, the Recommended model, this section) or **specific to the host project** (its instance, boards,
logins, subsystems, what Fixed means there, its model list). Project-independent rules go in THIS file, in
the `youtrack-agents` repository: commit and push here, then bump the submodule pointer in the host (`git add
tools/youtrack` there, commit). Never edit the host's `tools/youtrack/` directly; it is this repository checked
out as a submodule, and edits there are lost on the next update or detach its HEAD. Host-specific rules go in
the host's own agent instructions, in its YouTrack section. When it is not clear which, **ask the owner** before
writing it anywhere; do not put it in both places to be safe, and do not leave it only in a memory note.

### Getting a changed rule into force

Writing the rule down does not put it in force. **"Reread AGENTS.md" is a read, and the copy on disk can be
behind for three reasons, none of which reading fixes:**

1. the submodule was never initialised — `git submodule status` shows a leading `-` and the directory is empty;
2. the pointer moved but this worktree has not checked it out — a leading `+`. **A pinned submodule reads
   exactly like a current one**, so this fails silently and confidently;
3. the worktree's branch does not carry the change at all.

Demonstrated, not assumed: immediately after merging a rules change into a host project's integration branch,
`git submodule status` reported `+dca03a0... tools/youtrack` — the new rules in the recorded pointer, the old
rules still the bytes on disk. An agent told to reread at that moment would have read the superseded file.

**To pick up a rules change, in EVERY worktree you use** (submodules clone per working tree):

```
git fetch origin
git merge origin/<the branch that carries rules>
git submodule update --init
git submodule status                 # verify: no leading + and no leading -
```

...and only then reread. Host-repo rules that are not in a submodule — code formatting, review checklists —
have only reason 3, so the same procedure covers them with the submodule steps a no-op.

**If you are the one changing the rules, pushing is not finishing.** It is finished when every other agent can
*prove* it has the new text. Say which repository and commit, which branch carries it, the exact commands
above, and give a **sentinel**: a distinctive phrase from the new wording, with the check that reads it.

```
grep -c "<a phrase only the new version contains>" <the file>     # 0 means you are still on the old rules
```

A sentinel turns a silent staleness bug into a one-line check, which is the difference between a rule that is
written down and a rule that is in force.

## This repository's own code

Not a YouTrack-workflow rule (see "Where a new rule goes" above) but stated here because it is about editing
`client.ts`, `identity.ts` and `yt.ts` themselves, not about how a host project uses them.

- Formatting is Prettier, config in `.prettierrc.json` (120 columns). Run it rather than hand-wrapping.
- New code and any file substantially touched follows the condensed form of
  [Google's TypeScript style guide](https://google.github.io/styleguide/tsguide.html) kept at
  [`docs/typescript-style-guide.md`](docs/typescript-style-guide.md). Not a retrofit — untouched code keeps its
  existing shape.
- Prose anywhere in this repository — comments, README, this file, commit messages — uses UK/Canadian
  spelling and idiom (colour, centre, behaviour, organise, travelling, ...). New/touched prose only, not a
  retrofit of what is already written. See README.md "Conventions" for why this is written down at all.
- **Never force-push `main`**, and never rewrite a commit that is already on it (amend, rebase, squash, reset).
  Host projects pin this repository as a submodule at a `main` commit, and a rewritten commit leaves their pointer
  aimed at nothing. Every change lands as a new commit on top, pushed normally.

## Subsystems

`Subsystem` is the board's swimlane and is required on every issue. The project defines the list and the rule
for choosing one (usually: by the code directory the change lands in; for non-code work, by the subject; an
issue that cannot pick one is an epic). Add one with `yt subsystems add 'Name' --description '...'`, which puts
it in the field and in the board's swimlane list together, then add its row to the project's table.

## Auditing documents against the tracker

A periodic clean-up round keeps documents and the tracker honest. For every document that carries open-looking
items (task packets, handoffs, plans, open-issue lists, runbooks): check each claim against the code and the
history, not the document; classify it DONE (say where), OPEN (an issue exists or is filed), REVIEW (unclear
whether done, wanted or superseded: file an owner-review issue in To be discussed) or STALE (fix the statement
in place); and add a dated audit block directly under the title:

```
> **Audit YYYY-MM-DD** (claims checked against <branch> <sha>; open items tracked in YouTrack project PRJ):
> - DONE. <what, where, commit>
> - OPEN: <what>. Tracked as [PRJ-n](https://<instance>/issue/PRJ-n)
> - REVIEW: <what is unclear and why>. Tracked as [PRJ-m](...)
> - STALE: <statement> -> <correction made below>.
```

Done work without an issue gets no issue. Superseded documents get a one-line banner under the title and are
kept for history. Trust audit blocks over older prose.
