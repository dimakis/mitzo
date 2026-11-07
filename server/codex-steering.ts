import type { CodexSteerInput } from '@mitzo/protocol';
export { CodexSteerInputSchema, type CodexSteerInput } from '@mitzo/protocol';
export type CodexSteerStatus = 'accepted' | 'rejected' | 'uncertain';
export interface CodexSteerReceipt {
  input: CodexSteerInput;
  status: 'claimed' | CodexSteerStatus;
}
export type CodexSteerResult = { status: CodexSteerStatus | 'stale_target' };
