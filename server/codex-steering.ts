import type { CodexSteerInput } from '@mitzo/protocol';
export { CodexSteerInputSchema, type CodexSteerInput } from '@mitzo/protocol';
export type CodexSteerStatus = 'accepted' | 'rejected' | 'uncertain';
export interface CodexSteerReceipt {
  input: CodexSteerInput;
  status: 'claimed' | CodexSteerStatus;
}
export type CodexSteerResult = { status: CodexSteerStatus | 'stale_target' };
/** `unconfirmed` is the Claude SDK's terminal "turn ended without the provider echo" outcome;
 * Codex steering never produces it. */
export type UserSteerResult = CodexSteerResult | { status: 'unconfirmed' };
