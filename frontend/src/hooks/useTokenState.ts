import { useReducer, useCallback } from 'react';
import type { WsMsg } from '../lib/ws-pool';

export interface TokenState {
  agentContext: number; // input_tokens from latest message_start (context window size)
  sessionTotal: number; // cumulative input + output tokens
  costUsd: number; // estimated cost in USD
  numTurns: number; // number of turns
  turnIndex: number; // increments per message_start
}

export type TokenAction =
  | {
      type: 'TOKEN_UPDATE';
      agentContext: number;
      sessionTotal?: number;
      costUsd?: number;
      numTurns?: number;
      turnIndex: number;
    }
  | { type: 'RESET' };

const INITIAL_TOKEN_STATE: TokenState = {
  agentContext: 0,
  sessionTotal: 0,
  costUsd: 0,
  numTurns: 0,
  turnIndex: 0,
};

export function tokenStateReducer(state: TokenState, action: TokenAction): TokenState {
  switch (action.type) {
    case 'TOKEN_UPDATE':
      return {
        agentContext: action.agentContext,
        sessionTotal: action.sessionTotal ?? state.sessionTotal,
        costUsd: action.costUsd ?? state.costUsd,
        numTurns: action.numTurns ?? state.numTurns,
        turnIndex: action.turnIndex,
      };
    case 'RESET':
      return INITIAL_TOKEN_STATE;
    default:
      return state;
  }
}

export function useTokenState() {
  const [tokenState, tokenDispatch] = useReducer(tokenStateReducer, INITIAL_TOKEN_STATE);

  const handleTokenMessage = useCallback((msg: WsMsg) => {
    if (msg.type === 'token_update') {
      tokenDispatch({
        type: 'TOKEN_UPDATE',
        agentContext: msg.agentContext as number,
        sessionTotal: msg.sessionTotal as number | undefined,
        costUsd: msg.costUsd as number | undefined,
        numTurns: msg.numTurns as number | undefined,
        turnIndex: msg.turnIndex as number,
      });
    }
  }, []);

  return { tokenState, tokenDispatch, handleTokenMessage };
}
