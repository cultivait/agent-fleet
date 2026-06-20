// Resolve the owner_sid that binds a plan-task claim/heartbeat to this instance.
//
// The meta-harness keys three surfaces on ONE identity: the board card's `sid`,
// the lease-heartbeat hook's `session_id`, and a task's `owner_sid`. All three
// are the Claude Code session id, which the MCP server inherits as
// CLAUDE_CODE_SESSION_ID. Auto-binding owner_sid to it (instead of relying on the
// model to pass it) is what makes board-join (3B) and lease-heartbeat (4B) hit the
// right task. An explicit caller value still wins so a coordinator can claim on
// another session's behalf and tests stay deterministic.
export function resolveOwnerSid(
  explicit?: string | null,
  env?: string | undefined,
): string | undefined {
  const e = typeof explicit === "string" ? explicit.trim() : "";
  if (e) return e;
  const v = typeof env === "string" ? env.trim() : "";
  return v || undefined;
}
