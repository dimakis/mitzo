import type { SessionRegistry } from './session-registry.js';

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

  const policy = session.activeSkillPolicy;
  if (!policy) return 'allow';

  return policy.has(toolName) ? 'allow' : 'deny';
}
