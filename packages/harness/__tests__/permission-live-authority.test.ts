import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { SessionRegistry } from '../src/session-registry.js';
import { getPendingRequestsBySession, resolvePending } from '../src/permissions.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

const registries: SessionRegistry[] = [];
const callbacks: AbortController[] = [];
afterEach(() => {
  for (const callback of callbacks.splice(0)) callback.abort();
  for (const registry of registries.splice(0)) registry.dispose();
  warn.mockClear();
});

function fixture() {
  const registry = new SessionRegistry();
  registries.push(registry);
  const owner = new AbortController();
  const callback = new AbortController();
  callbacks.push(callback);
  const send = vi.fn();
  registry.register('client', {
    sessionId: 'conversation',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: owner,
    transport: { isOpen: () => true, send },
  });
  return { registry, owner, callback, send };
}

describe('live SDK approval authority', () => {
  it('refuses asynchronous authority checks and preserves their rejection cause internally', async () => {
    const { registry, callback, send } = fixture();
    const cause = Error('private asynchronous account identity changed');
    const result = await buildPermissionHandler('client', registry, {
      assertCurrentSync: () => Promise.reject(cause),
    })(
      'Read',
      { file_path: '/repo/a' },
      {
        signal: callback.signal,
        toolUseID: 'async-authority',
      },
    );

    expect(result).toMatchObject({
      behavior: 'deny',
      message: 'Original tool authority is no longer current; retry under current permissions',
    });
    expect(JSON.stringify(result)).not.toContain(cause.message);
    expect(send).not.toHaveBeenCalled();
    expect(registry.get('client')!.sessionAllowList.size).toBe(0);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Asynchronous tool authority check rejected',
        expect.objectContaining({
          err: cause,
          sessionId: 'conversation',
          toolName: 'Read',
          toolUseID: 'async-authority',
          stage: 'approval_authority',
          code: 'tool_approval_authority_async_rejected',
        }),
      ),
    );
  });

  it('cancels the original card when its session ends even if the SDK callback signal stays live', async () => {
    const { registry, owner, callback, send } = fixture();
    const pending = buildPermissionHandler('client', registry)(
      'Bash',
      { command: 'pwd' },
      {
        signal: callback.signal,
        toolUseID: 'native-invocation',
      },
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const request = send.mock.calls[0][0];
    owner.abort();
    expect(callback.signal.aborted).toBe(false);
    expect(getPendingRequestsBySession('conversation')).toEqual([]);
    expect(await pending).toMatchObject({
      behavior: 'deny',
      failure: { code: 'cancelled', effectStatus: 'not_started' },
    });
    expect(resolvePending(request.permId, 'always')).toBe(false);
    expect(registry.get('client')!.sessionAllowList.size).toBe(0);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'cancelled',
          phase: 'approval',
          effectStatus: 'not_started',
        }),
      }),
    );
  });

  it.each(['ask', 'agent', 'auto'] as const)(
    'never auto-allows a cancelled %s callback',
    async (mode) => {
      const { registry, owner, callback } = fixture();
      registry.setMode('client', mode);
      owner.abort();
      expect(
        await buildPermissionHandler('client', registry)(
          'Read',
          { file_path: '/repo/a' },
          {
            signal: callback.signal,
            toolUseID: 'cancelled-read',
          },
        ),
      ).toMatchObject({ behavior: 'deny', failure: { code: 'cancelled' } });
    },
  );

  it('checks the existing SDK authority again before recording approval or retaining a grant', async () => {
    const { registry, callback, send } = fixture();
    let current = true;
    const assertCurrentSync = vi.fn(() => {
      if (!current) throw Error('private account identity changed');
    });
    const pending = buildPermissionHandler('client', registry, { assertCurrentSync })(
      'Bash',
      { command: 'pwd' },
      { signal: callback.signal, toolUseID: 'approval' },
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    current = false;
    resolvePending(send.mock.calls[0][0].permId, 'always');
    expect(await pending).toMatchObject({
      behavior: 'deny',
      message: 'Original tool authority is no longer current; retry under current permissions',
    });
    expect(registry.get('client')!.sessionAllowList.size).toBe(0);
    expect(assertCurrentSync.mock.calls.length).toBeGreaterThan(1);
  });

  it('replays the original card after reattach and settles it only once', async () => {
    const { registry, callback, send } = fixture();
    const effect = vi.fn();
    const pending = buildPermissionHandler('client', registry)(
      'Bash',
      { command: 'pwd' },
      {
        signal: callback.signal,
        toolUseID: 'one-native-invocation',
      },
    ).then((result) => {
      if (result.behavior === 'allow') effect(result.updatedInput);
      return result;
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const original = send.mock.calls[0][0];
    registry.detach('client');
    const replay = getPendingRequestsBySession('conversation');
    expect(replay).toEqual([
      expect.objectContaining({ permId: original.permId, expiresAt: original.expiresAt }),
    ]);
    expect(registry.reattach('client', { send, isOpen: () => true })).toBe(true);
    expect(resolvePending(original.permId, 'once', undefined, 'foreign-conversation')).toBe(false);
    expect(resolvePending(original.permId, 'once', undefined, 'conversation')).toBe(true);
    expect(resolvePending(original.permId, 'once', undefined, 'conversation')).toBe(false);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect(effect).toHaveBeenCalledExactlyOnceWith({ command: 'pwd' });
    expect(getPendingRequestsBySession('conversation')).toEqual([]);
  });
});
