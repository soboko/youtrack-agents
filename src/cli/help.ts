/** Usage text with the project's own key in the examples; `PRJ` when none is configured (YA-25 B12). */
export function help(project = 'PRJ'): string {
  return `yt: YouTrack for agents (project ${project})

  yt whoami                                   token check: who the API sees
  yt fields                                   the project's fields and their allowed values
  yt field add 'Name' --values a,b,c          a global single-value enum field, attached to the project (idempotent)
  yt board [--board 'Name']                   unresolved issues by kanban column (State), up to 500; default board is YOUTRACK_BOARD
  yt list [query] [--top N]                   issues matching a YouTrack query, e.g. 'State: Open' or 'Subsystem: {Map Client}';
                                              stderr says when more than N (default 50) matched
  yt show ${project}-1                                one issue with fields, description and comments
  yt create --summary S [--description D | --description-file F | --description -]
            --recommend <model id | 'owner (no model)'>   REQUIRED: which model should do it (yt fields lists the values)
            --role 'Builder'                  REQUIRED: who acts next (Director | Builder | Reviewer: correctness|security|testing|operations|product | Judge | Owner decides|verifies|operates)
            [--type Task] [--priority Normal] [--state Submitted] --subsystem S [--assignee login]
            [--set 'Field=Value' ...]         create an issue; AI Model / AI Session ID are filled in from identity
  yt take ${project}-1                                take it: In Progress, on the current sprint of every board that runs one, assigned to you;
                                              prints the issue's Role, the persona to read up on before touching anything
  yt handoff ${project}-1 'Owner decides' 'note' | --file F [--state S]
                                              ("Owner verifies" is refused here: that hand-off is 'yt state ... Fixed --check')
                                              leave it for the next role: sets Role, posts the "Hand-off to <role>" note (the pick-up
                                              spot), assigns the owner for the three Owner roles and unassigns for agent roles
  yt state ${project}-1 'In Progress'                 set State = move the card on the kanban board
  yt state ${project}-1 Fixed --check 'text' | --check-file F
                                              ...and post the "Things to check" comment; assigns the owner (YOUTRACK_OWNER, required) and sets
                                              Role 'Owner verifies'; 'To be discussed' assigns the owner and sets Role 'Owner decides'.
                                              --assign login | none overrides; --no-assign leaves it
  yt subsystem ${project}-1 'Map Client'              set the Subsystem swimlane
  yt subsystems [add 'Name' --description D]  list subsystems and swimlanes; add one to BOTH (a bundle value with no swimlane
                                              puts its cards in "Uncategorized Cards")
  yt assign ${project}-1 login|none
  yt set ${project}-1 'Field=Value' ['Field=Value'...] set any fields by name; 'Field=' clears
  yt edit ${project}-1 [--summary S] [--description D | --description-file F]
  yt comment ${project}-1 'text' | --file F | -       add a comment (annotated with model and session)
  yt estimate ${project}-1 --time '2d 4h' --tokens 20M   set Estimation (senior dev with domain expertise) and Token Estimate
                                              tokens: 25M, 250k, 1.5M or a raw count; stored as millions (float)
  yt actual ${project}-1 --time 1h30m [--type Implementation] [--note 'what was done']
                                              log a work item. Token actuals are refused (no atomic increment on this
                                              provider) and nothing is written: record the estimate in the milestone comment
  yt work ${project}-1                                list logged work items
  yt cmd ${project}-1[,${project}-2] 'command' [--comment C]  YouTrack command language, e.g. 'State Fixed Priority Major'
  yt sprints [--board B]                      the board's sprints (default: YOUTRACK_SPRINT_BOARD, else YOUTRACK_BOARD)
  yt sprint add ${project}-1[,${project}-2] 'Sprint 1'        put issues on a sprint (the current one, unless the owner says otherwise)
  yt sprint create 'Sprint 2'                 a new sprint; the owner closes and opens sprints, agents only file into them
  yt sprint rename 'First sprint' 'Sprint 1'
  yt sprint enable | disable                  the board's sprint setting
  yt sprint backlog 'query'                   the board's backlog saved search (issues in it and on no sprint)

identity (stamped on every write):  --model <id>  --session <id>   or env AI_MODEL / AI_SESSION_ID
                                    (falls back to CLAUDE_CODE_SESSION_ID, AI_AGENT)
other:  --json  machine-readable output (workflow envelope version 1; non-completed workflows exit 1)     --quiet  no request log
        --debug  add the provider's error and error_description to HTTP errors (truncated, token removed; never the raw body)
        --project ${project}   --url https://...   (https only; http just for localhost)
`;
}

/** The usage text with the placeholder project key. */
export const HELP = help();
