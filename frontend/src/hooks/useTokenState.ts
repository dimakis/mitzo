import { useReducer, useCallback, useEffect, useRef } from 'react';
import type { WsMsg } from '../lib/ws-pool';

export interface TokenState {
  agentContext: number; // input_tokens from latest message_start (context window size)
  contextCeiling: number; // max context window for the current model
  sessionTotal: number; // cumulative input + output tokens
  costUsd: number; // estimated cost in USD
  numTurns: number; // number of turns
  turnIndex: number; // increments per message_start
}

const DEFAULT_CONTEXT_CEILING = 200_000;

export type TokenAction =
  | {
      type: 'TOKEN_UPDATE';
      agentContext: number;
      contextCeiling?: number;
      sessionTotal?: number;
      costUsd?: number;
      numTurns?: number;
      turnIndex: number;
    }
  | { type: 'RESET' };

const INITIAL_TOKEN_STATE: TokenState = {
  agentContext: 0,
  contextCeiling: DEFAULT_CONTEXT_CEILING,
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
        contextCeiling: action.contextCeiling ?? state.contextCeiling,
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

/**
 * Manages token usage state for the current session.
 * Resets automatically when sessionId changes (prevents stale data on navigation).
 */
export function useTokenState(sessionId?: string) {
  const [tokenState, tokenDispatch] = useReducer(tokenStateReducer, INITIAL_TOKEN_STATE);
  const prevSessionId = useRef(sessionId);

  // Reset token state when navigating between sessions
  useEffect(() => {
    if (prevSessionId.current !== sessionId) {
      prevSessionId.current = sessionId;
      tokenDispatch({ type: 'RESET' });
    }
  }, [sessionId]);

  const handleTokenMessage = useCallback((msg: WsMsg) => {
    if (msg.type === 'token_update') {
      tokenDispatch({
        type: 'TOKEN_UPDATE',
        agentContext: msg.agentContext,
        contextCeiling: msg.contextCeiling,
        sessionTotal: msg.sessionTotal,
        costUsd: msg.costUsd,
        numTurns: msg.numTurns,
        turnIndex: msg.turnIndex,
      });
    }
  }, []);

  return { tokenState, tokenDispatch, handleTokenMessage };
}
