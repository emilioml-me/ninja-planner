/**
 * Operator (platform-owner) workspace gate.
 *
 * Some integrations (Slack alerts, payments/helpdesk/schedule summaries) are wired to a single
 * GLOBAL credential with no tenant scoping — their data belongs to the platform operator, not to
 * any customer workspace. Those features must only run for workspaces listed in
 * OPERATOR_WORKSPACE_IDS (comma-separated workspace ids). Unset/empty => no workspace qualifies.
 */
function operatorIds(): Set<string> {
  return new Set(
    (process.env.OPERATOR_WORKSPACE_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isOperatorWorkspace(workspaceId: string): boolean {
  if (!workspaceId) return false;
  return operatorIds().has(workspaceId);
}
