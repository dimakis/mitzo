import { describe, it, expect } from 'vitest';
import { tokenStateReducer, type TokenState } from '../useTokenState';

const INITIAL: TokenState = {
  agentContext: 0,
  contextCeiling: 200_000,
  sessionTotal: 0,
  costUsd: 0,
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
      costUsd: 0.03,
      numTurns: 2,
      turnIndex: 1,
    });
    expect(state.sessionTotal).toBe(7000);
    expect(state.costUsd).toBe(0.03);
    expect(state.numTurns).toBe(2);
  });

  it('preserves previous session totals when not provided in update', () => {
    const prev: TokenState = {
      agentContext: 5000,
      contextCeiling: 200_000,
      sessionTotal: 7000,
      costUsd: 0.03,
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
    expect(state.costUsd).toBe(0.03); // preserved
  });

  it('resets on RESET', () => {
    const prev: TokenState = {
      agentContext: 87000,
      contextCeiling: 128_000,
      sessionTotal: 142000,
      costUsd: 1.82,
      numTurns: 5,
      turnIndex: 3,
    };
    const state = tokenStateReducer(prev, { type: 'RESET' });
    expect(state).toEqual(INITIAL);
  });
});
