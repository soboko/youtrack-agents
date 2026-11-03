/**
 * @fileoverview Who is writing to YouTrack. Every issue an agent creates carries `AI Model` and
 * `AI Session ID`, and every comment ends with the same pair as an annotation, so a human reading the
 * board can tell which model and which conversation produced a change.
 *
 * Resolution order for each value: explicit argument (CLI flag) > AI_MODEL / AI_SESSION_ID environment >
 * what the harness exposes > 'unknown'. Claude Code exposes CLAUDE_CODE_SESSION_ID (the local session
 * UUID) and AI_AGENT (harness + version), but not the model id, so a Claude Code agent should pass
 * --model, and preferably --session with the claude.ai/code session id from its attribution reminder,
 * which is the id a person can open.
 */

/** The model and session that produced a write, resolved from CLI flags, env, or the harness. */
export interface AgentIdentity {
  /** e.g. claude-fable-5-1, gpt-5-codex. */
  model: string;
  /** e.g. session_01AbCdEfGhIjKlMnOpQrStUv, or the harness UUID. */
  session: string;
}

/** Explicit overrides accepted for each identity field, e.g. from a --model/--session CLI flag. */
export interface IdentityOverrides {
  model?: string;
  session?: string;
}

/** Resolves the current agent's identity: explicit overrides, then environment, then 'unknown'. */
export function resolveIdentity(
  explicit: IdentityOverrides = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgentIdentity {
  const model = explicit.model || env.AI_MODEL || env.AI_AGENT || 'unknown';
  const session =
    explicit.session || env.AI_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || 'unknown';
  return {model, session};
}
