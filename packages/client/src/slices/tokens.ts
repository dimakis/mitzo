import type { ModelTokenLimits } from '@mitzo/protocol';

export interface TokensState {
  agentContext: number;
  contextCeiling: number;
  tokenLimits?: ModelTokenLimits | null;
  sessionTotal: number;
  /** Observed native snapshots are display evidence, not finalized turn billing. */
  sessionTotalStatus?: 'observed' | 'unknown';
  numTurns: number;
  turnIndex: number;
  numCompactions: number;
}

// Zero means unreported; there is no universal model capacity.
export const DEFAULT_CONTEXT_CEILING = 0;

export const INITIAL_TOKENS_STATE: TokensState = {
  agentContext: 0,
  contextCeiling: DEFAULT_CONTEXT_CEILING,
  sessionTotal: 0,
  numTurns: 0,
  turnIndex: 0,
  numCompactions: 0,
};
