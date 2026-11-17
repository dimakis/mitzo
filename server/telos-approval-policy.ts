import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { effectivePermissionMode, type ManagedSession } from '@mitzo/harness';
import { isReadOnlyBuiltinToolCall } from './builtin-tool-behavior.js';
import type { CapabilityReceipt } from './session-capability-grants.js';
import type { TelosSaveConsent } from './telos-save-consent.js';

const sdkPrefix = 'mcp__telos__';

/** Options an adapter merges over its exact request-only base approval. */
export interface TelosApprovalScope {
  forcePrompt?: boolean;
  allowSessionGrant?: boolean;
  sessionGrantKey?: string;
  isRetainedSessionGrantCurrent?: () => boolean;
  sessionGrantDescription?: string;
  approvalScope?: 'session' | 'request';
}

/** Outside Ask, reviewed Telos reads rely on their owners' pin, role, hash and
 * current() checks rather than a once card. Ask keeps its existing card. */
export function isUncardedTelosRead(
  session: ManagedSession,
  name: string,
  input: Record<string, unknown>,
): boolean {
  return (
    effectivePermissionMode(session) !== 'ask' &&
    isReadOnlyBuiltinToolCall(
      name.startsWith(sdkPrefix) ? name.slice(sdkPrefix.length) : name,
      input,
    )
  );
}

/** Single approval policy for the SDK and Codex Telos adapters. `decide` must
 * call the shared permission handler with a forced, request-only base, so mode,
 * skill, workspace and authority checks run on every path. */
export async function decideTelosApproval<R extends Pick<PermissionResult, 'behavior'>>(
  session: ManagedSession,
  name: string,
  input: Record<string, unknown>,
  decide: (scope: TelosApprovalScope) => Promise<R>,
  consent: { progress?: CapabilityReceipt; save?: TelosSaveConsent } = {},
): Promise<R> {
  if (isUncardedTelosRead(session, name, input)) {
    const result = await decide({ forcePrompt: false });
    // Ask may have been selected while shared checks awaited I/O; keep its card.
    if (result.behavior !== 'allow' || isUncardedTelosRead(session, name, input)) return result;
  }
  const { progress, save } = consent;
  if (progress)
    return decide({
      allowSessionGrant: true,
      sessionGrantKey: `telos-progress:${progress.grantId}`,
      isRetainedSessionGrantCurrent: () => {
        progress();
        return true;
      },
    });
  if (save)
    return decide({
      allowSessionGrant: true,
      sessionGrantKey: save.key,
      approvalScope: 'session',
      sessionGrantDescription:
        'Allow further document saves to this item in this conversation while its current role assignment lasts.',
    });
  return decide({});
}
