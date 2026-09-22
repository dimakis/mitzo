import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { admitProviderDispatch, preflightProviderDispatch } from '../provider-execution.js';

describe('provider execution admission', () => {
  const accountBinding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai',
    model: 'gpt-test',
    profileRevision: 'revision-1',
  };

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

  it('rejects reuse of a command identity through a different account binding', () => {
    const store = new EventStore(':memory:');
    store.upsertSession({ sessionId: 'session-1' });
    const base = {
      sessionId: 'session-1',
      clientMsgId: 'command-account',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
      accountBinding: {
        accountId: 'work',
        provider: 'openai',
        profileRevision: 'revision-1',
      },
    };

    try {
      admitProviderDispatch({ store, request: base, prepare: () => {} });
      expect(() =>
        preflightProviderDispatch(store, {
          ...base,
          accountBinding: { ...base.accountBinding, accountId: 'personal' },
        }),
      ).toThrow(/fingerprint/i);
      expect(() =>
        preflightProviderDispatch(store, {
          ...base,
          accountBinding: { ...base.accountBinding, profileRevision: 'revision-2' },
        }),
      ).toThrow(/fingerprint/i);
    } finally {
      store.close();
    }
  });

  it('accepts a pre-versioning fingerprint only for the durable account binding', () => {
    const store = new EventStore(':memory:');
    const request = {
      sessionId: 'session-legacy',
      clientMsgId: 'command-legacy',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      accountBinding,
    };
    const legacyFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          effectivePrompt: request.effectivePrompt,
          model: request.model,
          reasoningEffort: { specified: true, value: request.reasoningEffort },
        }),
      )
      .digest('base64url');
    store.upsertSession({ sessionId: request.sessionId, accountBinding });
    store.beginExecution(request.sessionId, undefined, request.clientMsgId, legacyFingerprint);

    try {
      expect(preflightProviderDispatch(store, request)).toBe(true);
      const prepare = vi.fn();
      expect(admitProviderDispatch({ store, request, prepare })).toMatchObject({
        duplicate: true,
        requestFingerprint: legacyFingerprint,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(() =>
        preflightProviderDispatch(store, {
          ...request,
          accountBinding: { ...accountBinding, accountId: 'personal' },
        }),
      ).toThrow(/fingerprint/i);
    } finally {
      store.close();
    }
  });

  it('accepts the unversioned account-bound fingerprint used during the rollout', () => {
    const store = new EventStore(':memory:');
    const request = {
      sessionId: 'session-account-bound',
      clientMsgId: 'command-account-bound',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      accountBinding,
    };
    const unversionedFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          effectivePrompt: request.effectivePrompt,
          model: request.model,
          reasoningEffort: { specified: true, value: request.reasoningEffort },
          accountBinding: {
            accountId: accountBinding.accountId,
            provider: accountBinding.provider,
            profileRevision: accountBinding.profileRevision,
          },
        }),
      )
      .digest('base64url');
    store.upsertSession({ sessionId: request.sessionId, accountBinding });
    store.beginExecution(request.sessionId, undefined, request.clientMsgId, unversionedFingerprint);

    try {
      expect(preflightProviderDispatch(store, request)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('rechecks a compatible legacy admission created during a rolling-upgrade race', () => {
    const store = new EventStore(':memory:');
    const prepare = vi.fn();
    const request = {
      sessionId: 'session-race',
      clientMsgId: 'command-race',
      effectivePrompt: 'answer this',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      accountBinding,
    };
    const legacyFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          effectivePrompt: request.effectivePrompt,
          model: request.model,
          reasoningEffort: { specified: true, value: request.reasoningEffort },
        }),
      )
      .digest('base64url');
    store.upsertSession({ sessionId: request.sessionId, accountBinding });
    const beginExecution = store.beginExecution.bind(store);
    vi.spyOn(store, 'beginExecution').mockImplementationOnce((...args) => {
      beginExecution(request.sessionId, undefined, request.clientMsgId, legacyFingerprint);
      return beginExecution(...args);
    });

    try {
      expect(admitProviderDispatch({ store, request, prepare })).toMatchObject({
        duplicate: true,
        requestFingerprint: legacyFingerprint,
      });
      expect(prepare).not.toHaveBeenCalled();
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
