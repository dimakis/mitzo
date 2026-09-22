import { describe, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { admitProviderDispatch, preflightProviderDispatch } from '../provider-execution.js';

describe('provider execution admission', () => {
  it('reuses an exact durable admission without preparing a second dispatch', () => {
    const store = new EventStore(':memory:');
    const prepare = vi.fn();
    const request = {
      sessionId: 'session-1',
      clientMsgId: 'command-1',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
      reasoningEffort: 'medium',
    };
    store.upsertSession({ sessionId: request.sessionId });

    try {
      const first = admitProviderDispatch({ store, request, prepare });
      const retry = admitProviderDispatch({ store, request, prepare });

      expect(first.duplicate).toBe(false);
      expect(retry).toEqual({ ...first, duplicate: true });
      expect(prepare).toHaveBeenCalledOnce();
      expect(store.getExecutionAdmission(request.sessionId, request.clientMsgId)).toEqual({
        token: first.token,
        requestFingerprint: first.requestFingerprint,
      });
    } finally {
      store.close();
    }
  });

  it('fails closed before preparation when a command identity changes', () => {
    const store = new EventStore(':memory:');
    const prepare = vi.fn();
    store.upsertSession({ sessionId: 'session-1' });

    try {
      admitProviderDispatch({
        store,
        request: {
          sessionId: 'session-1',
          clientMsgId: 'command-1',
          effectivePrompt: 'first prompt',
          model: 'gpt-test',
        },
        prepare,
      });

      expect(() =>
        admitProviderDispatch({
          store,
          request: {
            sessionId: 'session-1',
            clientMsgId: 'command-1',
            effectivePrompt: 'changed prompt',
            model: 'gpt-test',
          },
          prepare,
        }),
      ).toThrow(/fingerprint/i);
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it('distinguishes omitted reasoning effort from an explicit reset', () => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'session-1' });
    const base = {
      sessionId: 'session-1',
      clientMsgId: 'command-reasoning',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
    };

    try {
      admitProviderDispatch({ store, request: base, prepare: () => {} });
      expect(() =>
        admitProviderDispatch({
          store,
          request: { ...base, reasoningEffort: null },
          prepare: () => {},
        }),
      ).toThrow(/fingerprint/i);
    } finally {
      store.close();
    }
  });

  it('terminalizes a failed preparation without creating a provider attempt', () => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'session-1' });

    try {
      const request = {
        sessionId: 'session-1',
        clientMsgId: 'command-1',
        effectivePrompt: 'answer this',
      };
      expect(() =>
        admitProviderDispatch({
          store,
          request,
          prepare: () => {
            throw new Error('prepare failed');
          },
        }),
      ).toThrow('prepare failed');
      expect(store.getSession('session-1')).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'startup_failed',
      });
      const admission = store.getExecutionAdmission('session-1', 'command-1');
      expect(admission).toBeDefined();
      expect(store.getProviderAttempts(admission!.token)).toEqual([]);
      expect(() => admitProviderDispatch({ store, request, prepare: vi.fn() })).toThrow(
        /failed before provider dispatch/i,
      );
      expect(() => preflightProviderDispatch(store, request)).toThrow(
        /failed before provider dispatch/i,
      );
    } finally {
      store.close();
    }
  });
});
