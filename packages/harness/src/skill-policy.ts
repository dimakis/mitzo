import type { SessionRegistry } from './session-registry.js';

// These routes cannot propagate and revalidate the caller's tool ceiling in
// independently executing workers. An explicit entry cannot qualify that route.
const unsupportedDelegation = new Set([
  'Agent',
  'Task',
  'StartSession',
  'TelosCreateSession',
  'mcp__mitzo-connections__StartSession',
  'mcp__mitzo-connections__TelosCreateSession',
  'mcp__telos__TelosCreateSession',
]);

/**
 * Set the active skill tool restriction for a session.
 * Only restricts — never expands beyond the mode's allowed tools.
 */
export function setSkillPolicy(
  registry: SessionRegistry,
  clientId: string,
  allowedTools: string[],
): void {
  const session = registry.get(clientId);
  if (session) {
    session.activeSkillPolicy = new Set(allowedTools);
  }
}

/**
 * Clear the active skill policy (e.g., when a plain message is sent).
 */
export function clearSkillPolicy(registry: SessionRegistry, clientId: string): void {
  const session = registry.get(clientId);
  if (session) {
    session.activeSkillPolicy = null;
  }
}

/**
 * Check whether a tool is allowed under the current skill policy.
 * Returns 'allow' if no policy is active or tool is in the list.
 * Returns 'deny' if a policy is active and the tool is not in it.
 *
 * This must be checked BEFORE shouldAutoAllow() in the permission handler,
 * so that even safe-tier tools can be blocked by a skill restriction.
 */
export function checkSkillPolicy(
  registry: SessionRegistry,
  clientId: string,
  toolName: string,
): 'allow' | 'deny' {
  const session = registry.get(clientId);
  if (!session) return 'allow';

  return checkSkillTool(session.activeSkillPolicy, toolName);
}

/** The same ceiling semantics for a frozen command snapshot and legacy sessions. */
export function checkSkillTool(
  policy: ReadonlySet<string> | null | undefined,
  toolName: string,
): 'allow' | 'deny' {
  if (!policy) return 'allow';

  if (unsupportedDelegation.has(toolName)) return 'deny';

  return policy.has(toolName) ? 'allow' : 'deny';
}
