# Adopting youtrack-agents in a project

Two sides have to be set up: the YouTrack project (fields, states, boards) and the host repository (the tool as
a submodule, the configuration, and a project-specific section in the host's agent instructions). This page is
the checklist for both; `templates/AGENTS-section.md` is the block to copy into the host's `AGENTS.md` (or
`CLAUDE.md`) and fill in. Nothing in `AGENTS.md` here needs editing per project; everything project-specific
goes in the host's section.

## 1. YouTrack side

Do this once, as a project admin, with the token the agents will use.

1. **Project.** Create it; note the short name (the part before the dash in issue ids, e.g. `PRJ`).
2. **Token.** A permanent token for the agent user (Profile > Account Security > Tokens), YouTrack scope. One
   shared agent user is fine: the model and session that made each write are stamped on the issue.
3. **Fields.** `yt fields` shows what exists. The rules expect:
   - `State` with, at least, `Submitted`, `Open`, `Reopened`, `In Progress`, `To be discussed`, `Fixed`,
     `Verified`, and the closed states `Won't fix`, `Duplicate`, `Can't Reproduce`, `Incomplete`, `Obsolete`.
     **`Fixed` must be unresolved and `Verified` resolved** (Project > Fields > State > edit the values), or Fixed
     cards strike through before the owner has looked.
   - `Subsystem`: an owned-field bundle (YouTrack's default "Subsystem" field works). Its values are the
     swimlanes; add them with `yt subsystems add 'Name' --description '...'` after the board exists.
   - `Type`, `Priority`, `Assignee`: the defaults.
   - `Estimation` and `Spent time` (period): enable time tracking on the project with those two fields; define
     work item types (e.g. Development, Implementation, Testing, Documentation, Investigation).
   - `Token Estimate` and `Actual Tokens`: float fields, holding millions.
   - `AI Model` and `AI Session ID`: string fields.
   - `Recommended model`: `yt field add 'Recommended model' --values '<your model ids>,owner (no model)'`.
   - `Role`: `yt field add 'Role' --values 'Director,Builder,Reviewer: correctness,Reviewer: security,Reviewer: testing,Reviewer: operations,Reviewer: product,Judge,Owner decides,Owner verifies,Owner operates'` (see `src/workflow/policy.ts` and AGENTS.md "Role").
4. **Boards.** One kanban board, columns = `State` (in the order above), swimlanes = `Subsystem`. Optionally a
   second board restricted to some swimlanes. For each board:
   - `yt sprint enable --board 'Name'` (sets explicit membership too), rename the default sprint to `Sprint 1`
     (`yt sprint rename 'First sprint' 'Sprint 1' --board 'Name'`).
   - `yt sprint backlog 'project: PRJ #Unresolved Board Name: -{Current sprint}' --board 'Name'` (narrow a
     second board's query with `Subsystem: {A}, {B}`). The tool shares the saved search with the project's team
     group so the owner can see it.
   - A board created through the API belongs to the API user and is invisible to everyone else until its
     sharing is project-based; boards created in the UI by the owner avoid that.
5. **Owner.** Decide which login receives anything waiting on a person and set `YOUTRACK_OWNER`. It is required:
   without it, the commands that assign the owner (`yt state ... Fixed`, `'To be discussed'`, Owner-role hand-offs)
   refuse, and `yt whoami` shows `owner: admin (default)`.

## 2. Host repository side

1. **Submodule.** `git submodule add <this repo> tools/youtrack` (any path works; the examples use this one).
   Contributors run `git submodule update --init --recursive` after checkout or merge and verify
   `git submodule status tools/youtrack` has no leading `+` or `-`. Follow the host's hook setup instructions.
2. **Configuration.** Copy `.env.youtrack.example` to the host's root as `.env.youtrack`, git-ignore it, fill in
   the URL, project, token and the optional board, sprint board and owner variables. Worktrees and other
   checkouts read `~/.config/youtrack-agents/env` or `YOUTRACK_ENV_FILE`. Document the variables where the host
   documents its environment.
3. **Agent instructions.** Copy `templates/AGENTS-section.md` into the host's agent instructions and fill in
   every `<...>`. It points agents at `tools/youtrack/AGENTS.md` for the rules and holds only what is specific to
   the project: instance and project, boards, owner login, what Fixed means there, where task documents live,
   the model values in use, and the subsystem table with its choosing rule and boundary rules. Keep the two
   files that way round: generic rules here, specifics in the host; if you find yourself editing a rule here
   for one project, it belongs in the host section.
4. **Identity.** Make sure whatever starts an agent session exports `AI_MODEL` and `AI_SESSION_ID` (see
   `AGENTS.md`, "Identity on every write"); a startup prompt or session hook is the usual place.
5. **First run.** `node tools/youtrack/yt.ts whoami`, then `yt fields`, then `yt board`.

## 3. Things every host has to decide

These are the blanks in the template, and each is a real decision:

- **Where the owner verifies work.** Fixed means the agent has finished and handed off its work. The host
  supplies the branch, preview/test URL (with port), and deployment details to include in the "Things to check"
  comment. Merge and deploy requirements stay independent of this state; Verified is the owner's acceptance.
- **Subsystems.** One row per area of the code, chosen by the directory a change lands in, plus the non-code
  subsystems the project wants (Documentation, Licensing, Help, Marketing, Finance are the usual set). Write
  the boundary rules for the cases that will come up ("X is A until Y, then B"). An issue that cannot pick one
  is an epic.
- **Where task documents live** and what they are called (packets, plans, handoffs), so "a task document
  always has an issue" has something to point at.
- **The model list** for `Recommended model`, and which of them means "a person".
- **The role files**: which document each agent Role (Director, Builder, the five Reviewers, Judge) reads before
  starting, so `yt take`'s "adopt that persona" points somewhere.
- **The current-sprint rule** when there are two boards: usually "the current sprint of both".

## Accounting capability

The current YouTrack adapter preserves existing Actual Tokens values but refuses token increments because
the documented API does not provide the required atomic update and retry guarantees. Time-only work entries
remain supported. Do not provision a ledger or server workflow automatically during adoption. See
[the accounting contract](docs/architecture/accounting.md) for the supported behavior and future options.
