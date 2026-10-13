import { describe, expect, it, vi } from 'vitest';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';

function fixture() {
  const client = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async () => ({ result: 'offline' })),
    close: vi.fn(),
  };
  const lease: FrozenHostCodexBootstrapLease = {
    client,
    profile: {
      accountId: 'personal',
      accountLabel: 'Personal',
      credentialRef: '/private/offline-fixture',
      email: 'offline@example.invalid',
      planType: 'plus',
      model: 'offline',
    },
    profile: {
      accountId: 'personal',
      accountLabel: 'Personal',
      model: 'offline',
      credentialRef: '/private/offline-source',
      email: 'fixture@example.test',
      planType: 'plus',
    },
    binding: {
      accountId: 'personal',
      provider: 'openai-codex',
      profileRevision: 'p1',
      accountLabel: 'Personal',
      model: 'offline',
    },
    privateHome: '/private/offline-fixture',
    executableSha256: 'a'.repeat(64),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    close: vi.fn(() => client.close()),
  };
  let current: FrozenHostCodexBootstrapLease | undefined = lease;
  const bridge = new OwnedCodexLifecycleBridge(() => current);
  const owner: CodexLifecycleTransport = {
    onRequest: vi.fn(async () => ({ content: 'owner-result' })),
    onNotification: vi.fn(),
    onClose: vi.fn(),
  };
  return {
    bridge,
    lease,
    owner,
    client,
    setCurrent: (next: FrozenHostCodexBootstrapLease | undefined) => {
      current = next;
    },
  };
}

describe('owned Codex lifecycle bridge', () => {
  it('hands the existing preflight client to exactly one owner without initializing or launching it', () => {
    const f = fixture();
    expect(f.bridge.attach(f.owner)).toBe(f.client);
    expect(f.client.initialize).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.lease.assertCurrentSync).toHaveBeenCalledOnce();
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
  });

  it('rejects bootstrap host requests before owner attachment and never revives that transport', async () => {
    const f = fixture();
    await expect(
      f.bridge.lifecycle.onRequest(
        'item/tool/call',
        { secret: 'provider-secret' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Owned Codex lifecycle unavailable');
    expect(f.owner.onRequest).not.toHaveBeenCalled();
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
  });

  it.each(['thread/started', 'turn/started', 'item/started'])(
    'rejects unexpected pre-attachment execution notification %s',
    (method) => {
      const f = fixture();
      expect(() =>
        f.bridge.lifecycle.onNotification(method, { secret: 'provider-secret' }),
      ).toThrow('Owned Codex lifecycle unavailable');
      expect(f.owner.onNotification).not.toHaveBeenCalled();
      expect(f.lease.close).toHaveBeenCalledOnce();
      expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
    },
  );

  it('allows bootstrap account observations without inventing a conversation owner', () => {
    const f = fixture();
    f.bridge.lifecycle.onNotification('account/updated', { identity: 'private' });
    f.bridge.lifecycle.onNotification('account/rateLimits/updated', {});
    expect(f.owner.onNotification).not.toHaveBeenCalled();
    expect(f.lease.close).not.toHaveBeenCalled();
    expect(f.bridge.attach(f.owner)).toBe(f.client);
  });

  it('retains transport closure received before a lease exists, closes a delayed lease and refuses binding', () => {
    const f = fixture();
    f.setCurrent(undefined);
    f.bridge.lifecycle.onClose(new Error('provider-secret'));
    f.setCurrent(f.lease);
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.owner.onClose).not.toHaveBeenCalled();
  });

  it('does not bind if the synchronous authority fence closes the transport reentrantly', () => {
    const f = fixture();
    vi.mocked(f.lease.assertCurrentSync).mockImplementation(() => {
      f.bridge.lifecycle.onClose(new Error('private close evidence'));
    });
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.owner.onClose).not.toHaveBeenCalled();
  });

  it('rejects a reentrant second owner while attachment is still qualifying', () => {
    const f = fixture();
    let entered = false;
    vi.mocked(f.lease.assertCurrentSync).mockImplementation(() => {
      if (entered) return;
      entered = true;
      expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
    });
    expect(f.bridge.attach(f.owner)).toBe(f.client);
  });

  it('checks async and final synchronous authority before forwarding a host tool request', async () => {
    const f = fixture();
    f.bridge.attach(f.owner);
    vi.mocked(f.lease.assertCurrentSync).mockClear();
    const signal = new AbortController().signal;
    await expect(
      f.bridge.lifecycle.onRequest('item/tool/call', { callId: 'owned-call' }, signal),
    ).resolves.toEqual({ content: 'owner-result' });
    expect(f.lease.assertCurrent).toHaveBeenCalledOnce();
    expect(f.lease.assertCurrentSync).toHaveBeenCalledTimes(3);
    expect(f.owner.onRequest).toHaveBeenCalledWith(
      'item/tool/call',
      { callId: 'owned-call' },
      expect.any(AbortSignal),
    );
    expect(vi.mocked(f.lease.assertCurrent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.owner.onRequest).mock.invocationCallOrder[0],
    );
  });

  it('refuses a revoked lease after async qualification before any host tool is invoked', async () => {
    const f = fixture();
    f.bridge.attach(f.owner);
    vi.mocked(f.lease.assertCurrent).mockImplementation(async () => {
      vi.mocked(f.lease.assertCurrentSync).mockImplementation(() => {
        throw Error('private revocation evidence');
      });
    });
    await expect(
      f.bridge.lifecycle.onRequest('item/tool/call', {}, new AbortController().signal),
    ).rejects.toThrow('Owned Codex lifecycle unavailable');
    expect(f.owner.onRequest).not.toHaveBeenCalled();
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.owner.onClose).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Owned Codex lifecycle unavailable' }),
    );
  });

  it('uses a synchronous notification fence and rejects changing the owned lease', () => {
    const f = fixture();
    f.bridge.attach(f.owner);
    f.bridge.lifecycle.onNotification('turn/started', { turn: { id: 'turn-1' } });
    expect(f.owner.onNotification).toHaveBeenCalledOnce();
    f.setCurrent({ ...f.lease });
    expect(() => f.bridge.lifecycle.onNotification('turn/completed', {})).toThrow(
      'Owned Codex lifecycle unavailable',
    );
    expect(f.owner.onNotification).toHaveBeenCalledOnce();
    expect(f.lease.close).toHaveBeenCalledOnce();
  });

  it('aborts in-flight host callbacks when the native transport closes and sanitizes its error', async () => {
    const f = fixture();
    f.bridge.attach(f.owner);
    let observed: AbortSignal | undefined;
    let resolve!: (value: Record<string, unknown>) => void;
    vi.mocked(f.owner.onRequest).mockImplementation(async (_method, _params, signal) => {
      observed = signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const operation = f.bridge.lifecycle.onRequest(
      'item/tool/call',
      {},
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(observed).toBeDefined());
    f.bridge.lifecycle.onClose(new Error('provider-secret'));
    expect(observed!.aborted).toBe(true);
    resolve({ content: 'retained actual tool result' });
    await expect(operation).rejects.toThrow('Owned Codex lifecycle unavailable');
    expect(f.owner.onClose).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Owned Codex lifecycle unavailable' }),
    );
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
  });

  it('keeps a closed bridge closed after a callback throws and does not expose raw provider data', async () => {
    const f = fixture();
    f.bridge.attach(f.owner);
    vi.mocked(f.owner.onRequest).mockRejectedValue(new Error('provider-secret'));
    await expect(
      f.bridge.lifecycle.onRequest(
        'item/tool/call',
        { secret: 'provider-secret' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Owned Codex lifecycle unavailable');
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(() => f.bridge.attach(f.owner)).toThrow('Owned Codex lifecycle unavailable');
  });
});
