import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IncomingWsMessage, type IncomingWsMessage as Message } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import {
  getPendingSessionId,
  hasPending,
  registerPending,
  removePending,
  resolvePending,
} from '../permissions.js';
import {
  assertLegacyOwnedControlAllowed,
  legacyChatOwnsAttachment,
} from '../owned-local-codex-control.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
});

function fixture(bound = true, harness: 'codex' | 'responses' | 'claude-sdk' = 'codex') {
  const store = new EventStore(':memory:');
  const registry = new SessionRegistry();
  const sessionId = randomUUID(),
    driverId = `driver:${sessionId}`,
    permId = `approval:${sessionId}`;
  const owner = { id: randomUUID(), expiresAt: Date.now() + 60_000 };
  const binding = {
    version: 2,
    account: {
      accountId: 'personal',
      provider:
        harness === 'responses'
          ? 'openai'
          : harness === 'claude-sdk'
            ? 'anthropic-vertex'
            : 'openai-codex',
      profileRevision: 'r1',
    },
    harness: { implementation: harness },
    execution: { location: 'local', targetId: 'host', targetRevision: 't1' },
  } as const;
  if (bound)
    store.createSessionWithRuntimeBinding(
      {
        sessionId,
        cwd: '/offline/checkout',
        repositoryWorkspaceId: sessionId,
        accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'fixture' },
      },
      binding,
    );
  else store.upsertSession({ sessionId });
  const originalTransport = { send: vi.fn(), isOpen: () => true };
  registry.register(driverId, {
    sessionId,
    transport: originalTransport,
    mode: 'ask',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    ...(bound ? { ownedLocalAuthSessionId: owner.id } : {}),
  });
  const approval = vi.fn();
  registerPending(permId, 'Bash', approval, { command: 'offline' }, undefined, sessionId);
  cleanups.push(() => {
    removePending(permId);
    registry.remove(driverId);
    store.close();
  });
  const effects = { stop: vi.fn(), send: vi.fn(), mode: vi.fn(), interrupt: vi.fn() };
  const reattach = vi.spyOn(registry, 'reattach');
  const observe = vi.spyOn(registry, 'addObserver');
  function actor(sameLogin: boolean) {
    const auth = sameLogin ? owner : { id: randomUUID(), expiresAt: Date.now() + 60_000 };
    const connectionId = `connection:${randomUUID()}`;
    const transport = { send: vi.fn(), isOpen: vi.fn(() => true) };
    claimTransportConnection(connectionId, auth.id);
    const release = bindAgentLibraryTransport(connectionId, auth);
    cleanups.push(() => {
      release();
      releaseTransportConnection(connectionId, auth.id);
    });
    return { auth, connectionId, clientId: connectionId, transport };
  }
  type Actor = ReturnType<typeof actor>;
  function dispatch(actor: Actor, input: Message) {
    const msg = IncomingWsMessage.parse(input);
    assertLegacyOwnedControlAllowed(actor.connectionId, actor.clientId, actor.transport, msg, {
      sessionRegistry: registry,
      eventStore: store,
    });
    if (msg.type === 'reattach') {
      if (registry.reattach(msg.clientId, actor.transport)) actor.clientId = msg.clientId;
    } else if (msg.type === 'subscribe') registry.addObserver(msg.sessionId, actor.transport);
    else if (msg.type === 'permission_response')
      resolvePending(
        msg.permId,
        msg.decision ?? 'deny',
        msg.answers,
        getPendingSessionId(msg.permId) ?? registry.get(actor.clientId)?.sessionId,
      );
    else if (msg.type === 'stop') effects.stop(actor.clientId);
    else if (msg.type === 'send') effects.send(msg);
    else if (msg.type === 'set_mode') effects.mode(msg);
    else if (msg.type === 'interrupt') effects.interrupt(msg);
  }
  return {
    store,
    registry,
    owner,
    binding,
    sessionId,
    driverId,
    permId,
    originalTransport,
    approval,
    effects,
    reattach,
    observe,
    actor,
    dispatch,
  };
}

it('denies foreign reattach before takeover and preserves the original attached transport', () => {
  const f = fixture(),
    other = f.actor(false);
  expect(() => f.dispatch(other, { type: 'reattach', clientId: f.driverId })).toThrow(
    'another login',
  );
  expect(f.reattach).not.toHaveBeenCalled();
  expect(other.clientId).toBe(other.connectionId);
  expect(f.registry.get(f.driverId)?.transport).toBe(f.originalTransport);
});

it('denies a known owned approval directly without reattaching or a current session', () => {
  const f = fixture(),
    other = f.actor(false);
  expect(() =>
    f.dispatch(other, { type: 'permission_response', permId: f.permId, decision: 'once' }),
  ).toThrow('another login');
  expect(f.approval).not.toHaveBeenCalled();
  expect(hasPending(f.permId)).toBe(true);
});

it('allows the original login to answer its actual approval without reattaching', () => {
  const f = fixture(),
    actor = f.actor(true);
  expect(f.registry.get(actor.clientId)).toBeUndefined();
  f.dispatch(actor, { type: 'permission_response', permId: f.permId, decision: 'once' });
  expect(f.approval).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow' }));
  expect(f.reattach).not.toHaveBeenCalled();
});

it.each(['stop', 'permission_response', 'interrupt', 'send', 'set_mode', 'subscribe'] as const)(
  'denies foreign %s even with a previously learned driver key',
  (type) => {
    const f = fixture(),
      other = f.actor(false);
    other.clientId = f.driverId;
    const msg: Message =
      type === 'permission_response'
        ? { type, permId: f.permId, decision: 'once' }
        : type === 'send'
          ? { type, prompt: '/offline-native', clientMsgId: 'foreign-send' }
          : type === 'interrupt'
            ? { type, prompt: 'replacement', clientMsgId: 'foreign-interrupt' }
            : type === 'set_mode'
              ? { type, mode: 'auto' }
              : type === 'subscribe'
                ? { type, sessionId: f.sessionId }
                : { type };
    expect(() => f.dispatch(other, msg)).toThrow('another login');
    for (const effect of Object.values(f.effects)) expect(effect).not.toHaveBeenCalled();
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.approval).not.toHaveBeenCalled();
  },
);

it('denies a foreign resume before observer, slash command or startup effects', () => {
  const f = fixture(),
    other = f.actor(false);
  expect(() =>
    f.dispatch(other, {
      type: 'send',
      resume: f.sessionId,
      prompt: '/offline-native',
      clientMsgId: 'resume',
    }),
  ).toThrow('another login');
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.effects.send).not.toHaveBeenCalled();
});

it('allows original-login reattach, Stop, approval and control-only interruption', () => {
  const f = fixture(),
    actor = f.actor(true);
  f.dispatch(actor, { type: 'reattach', clientId: f.driverId });
  expect(f.registry.get(f.driverId)?.transport).toBe(actor.transport);
  f.dispatch(actor, { type: 'stop' });
  f.dispatch(actor, { type: 'interrupt', prompt: 'replacement', clientMsgId: 'interrupt' });
  f.dispatch(actor, { type: 'permission_response', permId: f.permId, decision: 'once' });
  expect(f.effects.stop).toHaveBeenCalledWith(f.driverId);
  expect(f.effects.interrupt).toHaveBeenCalledOnce();
  expect(f.approval).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow' }));
});

it.each(['send', 'set_mode'] as const)(
  'refuses original-owner owned %s before legacy effects',
  (type) => {
    const f = fixture(),
      actor = f.actor(true);
    actor.clientId = f.driverId;
    const msg: Message =
      type === 'send'
        ? { type, prompt: '/offline-native', clientMsgId: 'owner-send' }
        : { type, mode: 'auto' };
    expect(() => f.dispatch(actor, msg)).toThrow('guarded admission');
    expect(f.effects.send).not.toHaveBeenCalled();
    expect(f.effects.mode).not.toHaveBeenCalled();
    expect(f.store.getSendCommand('owner-send')).toBeUndefined();
  },
);

it.each(['expired', 'revoked', 'released', 'closed'] as const)(
  'denies %s original authorization before Stop or approval',
  (state) => {
    const f = fixture(),
      actor = f.actor(true);
    actor.clientId = f.driverId;
    if (state === 'expired') actor.auth.expiresAt = Date.now() - 1;
    if (state === 'revoked') revokeAuthSession(actor.auth);
    if (state === 'released') releaseTransportConnection(actor.connectionId, actor.auth.id);
    if (state === 'closed') actor.transport.isOpen.mockReturnValue(false);
    expect(() => f.dispatch(actor, { type: 'stop' })).toThrow('another login');
    expect(() =>
      f.dispatch(actor, { type: 'permission_response', permId: f.permId, decision: 'once' }),
    ).toThrow('another login');
    expect(f.effects.stop).not.toHaveBeenCalled();
    expect(f.approval).not.toHaveBeenCalled();
  },
);

it('fails closed for a live bound Local row without a retained login subject', () => {
  const f = fixture(),
    actor = f.actor(true);
  delete f.registry.get(f.driverId)!.ownedLocalAuthSessionId;
  expect(() => f.dispatch(actor, { type: 'reattach', clientId: f.driverId })).toThrow(
    'another login',
  );
  expect(f.reattach).not.toHaveBeenCalled();
});

it('preserves unbound legacy reattach, Send, mode and approval behavior', () => {
  const f = fixture(false),
    actor = f.actor(false);
  f.dispatch(actor, { type: 'reattach', clientId: f.driverId });
  f.dispatch(actor, { type: 'send', prompt: 'legacy', clientMsgId: 'legacy-send' });
  f.dispatch(actor, { type: 'set_mode', mode: 'auto' });
  f.dispatch(actor, { type: 'permission_response', permId: f.permId, decision: 'once' });
  expect(f.effects.send).toHaveBeenCalledOnce();
  expect(f.effects.mode).toHaveBeenCalledOnce();
  expect(f.approval).toHaveBeenCalledOnce();
});

it('permits cold read-only history without granting runtime-bound Send', () => {
  const f = fixture(),
    actor = f.actor(false);
  f.registry.remove(f.driverId);
  expect(() => f.dispatch(actor, { type: 'subscribe', sessionId: f.sessionId })).not.toThrow();
  expect(() =>
    f.dispatch(actor, {
      type: 'send',
      resume: f.sessionId,
      prompt: 'cold',
      clientMsgId: 'cold-send',
    }),
  ).toThrow('guarded admission');
  expect(f.effects.send).not.toHaveBeenCalled();
});

it.each([false, true])(
  'refuses approval after losing the live owned subject (same login: %s)',
  (sameLogin) => {
    const f = fixture(),
      actor = f.actor(sameLogin);
    f.registry.remove(f.driverId);
    expect(() =>
      f.dispatch(actor, { type: 'permission_response', permId: f.permId, decision: 'once' }),
    ).toThrow('another login');
    expect(f.approval).not.toHaveBeenCalled();
    expect(hasPending(f.permId)).toBe(true);
  },
);

it('only detaches the exact current attachment, including after login teardown', () => {
  const f = fixture(),
    actor = f.actor(true);
  f.dispatch(actor, { type: 'reattach', clientId: f.driverId });
  releaseTransportConnection(actor.connectionId, actor.auth.id);
  expect(
    legacyChatOwnsAttachment(f.driverId, actor.transport, {
      sessionRegistry: f.registry,
      eventStore: f.store,
    }),
  ).toBe(true);
  expect(
    legacyChatOwnsAttachment(f.driverId, f.originalTransport, {
      sessionRegistry: f.registry,
      eventStore: f.store,
    }),
  ).toBe(false);
  expect(
    legacyChatOwnsAttachment('missing', actor.transport, {
      sessionRegistry: f.registry,
      eventStore: f.store,
    }),
  ).toBe(false);
});

it.each(['responses', 'claude-sdk'] as const)(
  'does not grandfather missing live owner authentication on a bound Local %s adapter',
  (harness) => {
    const f = fixture(true, harness),
      actor = f.actor(true);
    delete f.registry.get(f.driverId)!.ownedLocalAuthSessionId;
    expect(() => f.dispatch(actor, { type: 'subscribe', sessionId: f.sessionId })).toThrow(
      'another login',
    );
  },
);
