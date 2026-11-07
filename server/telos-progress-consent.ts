import type { ManagedSession } from '@mitzo/harness';
import { captureSessionCapability } from './session-capability-grants.js';
import { TelosUpdateItemInput } from './telos-item-tools.js';

/** General edits and lifecycle deletion are deliberately outside progress consent. */
export function captureTelosProgressConsent(session: ManagedSession, name: string, input: unknown) {
  if (name !== 'TelosUpdateItem') return;
  const parsed = TelosUpdateItemInput.safeParse(input);
  if (!parsed.success) return;
  return captureSessionCapability(session, { kind: 'telos-progress', itemId: parsed.data.itemId });
}
