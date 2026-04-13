// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { tokenStateReducer, useTokenState, type TokenState } from '../useTokenState';
import type { WsMsg } from '../../lib/ws-pool';

const INITIAL: TokenState = {
  agentContext: 0,
  contextCeiling: 200_000,
  sessionTotal: 0,
  numTurns: 0,
  turnIndex: 0,
};

describe('tokenStateReducer', () => {
  it('updates agent context on TOKEN_UPDATE', () => {
    const state = tokenStateReducer(INITIAL, {
      type: 'TOKEN_UPDATE',
      agentContext: 87204,
      turnIndex: 1,
    });
    expect(state.agentContext).toBe(87204);
    expect(state.turnIndex).toBe(1);
  });

  it('updates session totals when provided', () => {
    const state = tokenStateReducer(INITIAL, {
      type: 'TOKEN_UPDATE',
      agentContext: 5000,
      sessionTotal: 7000,
      numTurns: 2,
      turnIndex: 1,
    });
    expect(state.sessionTotal).toBe(7000);
    expect(state.numTurns).toBe(2);
  });

  it('preserves previous session totals when not provided in update', () => {
    const prev: TokenState = {
      agentContext: 5000,
      contextCeiling: 200_000,
      sessionTotal: 7000,
      numTurns: 2,
      turnIndex: 1,
    };
    const state = tokenStateReducer(prev, {
      type: 'TOKEN_UPDATE',
      agentContext: 12000,
      turnIndex: 2,
    });
    expect(state.agentContext).toBe(12000);
    expect(state.sessionTotal).toBe(7000); // preserved
  });

  it('allows explicit 0 to reset numTurns', () => {
    const prev: TokenState = {
      agentContext: 5000,
      contextCeiling: 200_000,
      sessionTotal: 7000,
      numTurns: 2,
      turnIndex: 1,
    };
    const state = tokenStateReducer(prev, {
      type: 'TOKEN_UPDATE',
      agentContext: 5000,
      numTurns: 0,
      turnIndex: 2,
    });
    expect(state.numTurns).toBe(0);
  });

  it('resets on RESET', () => {
    const prev: TokenState = {
      agentContext: 87000,
      contextCeiling: 128_000,
      sessionTotal: 142000,
      numTurns: 5,
      turnIndex: 3,
    };
    const state = tokenStateReducer(prev, { type: 'RESET' });
    expect(state).toEqual(INITIAL);
  });
});

describe('useTokenState', () => {
  it('dispatches TOKEN_UPDATE from handleTokenMessage', () => {
    const { result } = renderHook(() => useTokenState('session-1'));

    act(() => {
      result.current.handleTokenMessage({
        type: 'token_update',
        agentContext: 50000,
        contextCeiling: 200_000,
        turnIndex: 1,
      } as WsMsg);
    });

    expect(result.current.tokenState.agentContext).toBe(50000);
    expect(result.current.tokenState.turnIndex).toBe(1);
  });

  it('ignores non-token_update messages', () => {
    const { result } = renderHook(() => useTokenState('session-1'));

    act(() => {
      result.current.handleTokenMessage({ type: '_open' } as WsMsg);
    });

    expect(result.current.tokenState).toEqual(INITIAL);
  });

  it('resets token state when sessionId changes', () => {
    const { result, rerender } = renderHook(({ sessionId }) => useTokenState(sessionId), {
      initialProps: { sessionId: 'session-1' },
    });

    // Build up some state
    act(() => {
      result.current.handleTokenMessage({
        type: 'token_update',
        agentContext: 80000,
        contextCeiling: 200_000,
        sessionTotal: 120000,
        numTurns: 3,
        turnIndex: 2,
      } as WsMsg);
    });

    expect(result.current.tokenState.agentContext).toBe(80000);

    // Navigate to different session
    rerender({ sessionId: 'session-2' });

    expect(result.current.tokenState).toEqual(INITIAL);
  });

  it('does not reset when sessionId stays the same', () => {
    const { result, rerender } = renderHook(({ sessionId }) => useTokenState(sessionId), {
      initialProps: { sessionId: 'session-1' },
    });

    act(() => {
      result.current.handleTokenMessage({
        type: 'token_update',
        agentContext: 80000,
        contextCeiling: 200_000,
        turnIndex: 2,
      } as WsMsg);
    });

    rerender({ sessionId: 'session-1' });

    expect(result.current.tokenState.agentContext).toBe(80000);
  });
});
