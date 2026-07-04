export interface TokensState {
  agentContext: number;
  contextCeiling: number;
  sessionTotal: number;
  numTurns: number;
  turnIndex: number;
  numCompactions: number;
  compacting: boolean;
}

export const DEFAULT_CONTEXT_CEILING = 200_000;

export const INITIAL_TOKENS_STATE: TokensState = {
  agentContext: 0,
  contextCeiling: DEFAULT_CONTEXT_CEILING,
  sessionTotal: 0,
  numTurns: 0,
  turnIndex: 0,
  numCompactions: 0,
  compacting: false,
};
