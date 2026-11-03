## Issue tracking (YouTrack)

The rules for tracking work in YouTrack as an agent live with the tool, in `tools/youtrack/AGENTS.md`
(the `youtrack-agents` submodule). **Read that file first**; it is project-independent and covers identity
stamping, what gets tracked and the three placements (backlog, current sprint, start now), the board and state
model, sprints and the backlog, "Things to check" on Fixed, owner assignment, estimates and actuals, the
Recommended model field, and the document-audit convention. This section holds only what is specific to
<PROJECT NAME>.

- **Instance and project:** https://<instance>.youtrack.cloud, project `<PRJ>` ("<Project name>"). Configuration
  is the git-ignored `.env.youtrack` at the repo root (`~/.config/youtrack-agents/env` for worktrees); see
  <where the host documents environment variables>. `node tools/youtrack/yt.ts help` lists the commands.
- **Boards:** "<Main board name>" is the main board<; "<Second board name>" is the same view restricted to
  <which swimlanes>>. <Both run sprints, so "the current sprint" means the current sprint of both boards: put an
  issue on each (`yt sprint add <PRJ>-n 'Sprint N'` and again with `--board '<other board>'`). Sprint commands
  default to <which board>.>
- **The owner's login is `<login>`**; that is where anything waiting on a person goes.
- **Fixed means the agent has finished and handed off to the owner**, with a "Things to check" list. Include
  the branch/commit, merge/deploy status and test URL with its port. The owner verifies at <location>. Merge
  and deployment approval requirements remain separate; only the owner sets Verified.
- **Task documents** live in `<path>` (<what they are called>). Each gets one issue when opened: the issue
  description carries the document path, the document's <Ownership/header> section carries the issue id, and
  its progress notes repeat the estimate and actual numbers at milestones. Sub-tasks are comments or linked
  child issues.
- **Recommended model** values in use here: <model ids>, `owner (no model)`.
- **Role files** (what `yt take` tells you to read): Director `<path>`, Builder `<path>`, Reviewer: correctness
  `<path>`, security `<path>`, testing `<path>`, operations `<path>`, product `<path>`, Judge `<path>`. The three
  Owner roles are the owner; there is no file.

### Subsystems

`Subsystem` is the board's swimlane and is required on every issue; it is chosen by which code directory the
change lands in (non-code subsystems by subject). An issue that cannot pick one is an epic. Features, releases
and tuning rounds are tags, not subsystems.

| Subsystem | owns | code |
|---|---|---|
| <Name> | <what it owns> | `<directories>` |
| Documentation | the documents as deliverables: architecture and design docs, READMEs, task documents, audits | `docs/`, every README |
| Licensing | terms, third-party code and asset licences, attributions | <paths> |
| Help | user-facing help, onboarding, guides, hints | <paths> |
| Marketing | outward-facing copy, roadmap, launch material | <paths> |
| Finance | billing, pricing, payments, cost tracking | <paths> |

Adding a subsystem: `yt subsystems add 'Name' --description '...'`, which adds it to the field and to the
board's swimlane list; then add its row to this table.

Non-code work is tracked too: a licensing question, a document to write or correct, a help page, a piece of
copy is an issue in its subsystem like any other, filed when it is noticed.

Boundary rules: <"X is A until Y, then B"; "something shared by A and B is C"; "an outage is an Incident even
when the cause is obvious; the fix is a separate issue in the owning subsystem">.
