import { mkdtempSync, mkdirSync, symlinkSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { resolvePending, getPendingRequestsBySession } from '../permissions.js';
import {
  createCodexNativeApprovalHandler,
  type ApprovePreparedWorkspaceGrant,
} from '../codex-native-approvals.js';

const permissions = {
  network: null,
  fileSystem: { read: ['/extra/read'], write: ['/extra/write'] },
};
function fixture(
  mode: 'ask' | 'agent' | 'auto' = 'agent',
  timeoutMs = 60_000,
  approvePreparedWorkspaceGrant?: ApprovePreparedWorkspaceGrant,
) {
  const registry = new SessionRegistry();
  const sent: Record<string, unknown>[] = [];
  registry.register('client', {
    transport: { send: (message) => sent.push(message), isOpen: () => true },
    abortController: new AbortController(),
    mode,
    sessionId: 'session',
    sessionAllowList: new Set(),
  });
  let current = true;
  const controller = new AbortController();
  const fences: Array<() => void> = [];
  const context = {
    commandId: 'command',
    fileChangePaths: ['/workspace/changed-file'],
    requestId: 'rpc',
    threadId: 'thread',
    turnId: 'turn',
    registerResponseFence: (fence: () => void) => {
      fences.push(fence);
    },
    assertCurrentSync() {
      if (!current) throw Error('revoked');
    },
  };
  const handler = createCodexNativeApprovalHandler({
    registry,
    clientId: 'client',
    runtimeId: 'owned-runtime',
    environmentId: 'local',
    timeoutMs,
    approvePreparedWorkspaceGrant,
    deniedRoots: ['/credentials'],
    writeProtectedRoots: ['/authority'],
  });
  const params = {
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'item',
    startedAtMs: Date.now(),
    environmentId: 'local',
    cwd: '/workspace',
    reason: 'Need the selected files',
    permissions: structuredClone(permissions),
  };
  return {
    registry,
    sent,
    controller,
    context,
    fences,
    params,
    handler,
    revoke: () => {
      current = false;
    },
  };
}
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort();
    f.registry.dispose();
  }
  vi.useRealTimers();
});
function setup(
  mode: 'ask' | 'agent' | 'auto' = 'agent',
  timeoutMs?: number,
  approvePreparedWorkspaceGrant?: ApprovePreparedWorkspaceGrant,
) {
  const f = fixture(mode, timeoutMs, approvePreparedWorkspaceGrant);
  fixtures.push(f);
  return f;
}
async function request(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.sent[0]?.permId).toBeDefined());
  return f.sent[0].permId as string;
}

describe('native approval adapter with the existing pending owner', () => {
  it('uses the existing exact prepared-root receipt for a turn grant without another approval card', async () => {
    const assertCurrentSync = vi.fn();
    const approve = vi.fn<ApprovePreparedWorkspaceGrant>(async () => ({
      receiptId: 'existing-reservation-receipt',
      assertCurrentSync,
    }));
    const f = setup('agent', undefined, approve);
    const params = {
      ...f.params,
      permissions: { network: null, fileSystem: { read: null, write: ['/prepared/task'] } },
    };
    const pending = f.handler(
      'item/permissions/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    expect(approve).toHaveBeenCalledWith({
      runtimeId: 'owned-runtime',
      environmentId: 'local',
      commandId: 'command',
      threadId: 'thread',
      turnId: 'turn',
      requestId: 'rpc',
      itemId: 'item',
      root: '/prepared/task',
    });
    expect(await pending).toEqual({
      permissions: { fileSystem: params.permissions.fileSystem },
      scope: 'turn',
    });
    expect(f.sent).toEqual([]);
    expect(assertCurrentSync).toHaveBeenCalled();
    assertCurrentSync.mockImplementation(() => {
      throw Error('reservation released');
    });
    expect(f.fences[0]).toThrow('reservation released');
  });

  it('falls back to the existing human approval when the reservation owner returns no receipt', async () => {
    const approve = vi.fn<ApprovePreparedWorkspaceGrant>(async () => undefined);
    const f = setup('agent', undefined, approve);
    const params = {
      ...f.params,
      permissions: { network: null, fileSystem: { read: null, write: ['/prepared/task'] } },
    };
    const pending = f.handler(
      'item/permissions/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    resolvePending(await request(f), 'once', undefined, 'session');
    expect(approve).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ scope: 'turn' });
  });

  it('denies a failed reservation proof instead of prompting or granting', async () => {
    const approve = vi.fn<ApprovePreparedWorkspaceGrant>(async () => ({
      receiptId: 'existing-receipt',
      assertCurrentSync() {
        throw Error('reservation changed');
      },
    }));
    const f = setup('agent', undefined, approve);
    const params = {
      ...f.params,
      permissions: { network: null, fileSystem: { read: null, write: ['/prepared/task'] } },
    };
    expect(
      await f.handler('item/permissions/requestApproval', params, f.controller.signal, f.context),
    ).toEqual({ permissions: {}, scope: 'turn' });
    expect(f.sent).toEqual([]);
  });

  it('cancels a stalled reservation check without emitting a grant or another card', async () => {
    const approve = vi.fn<ApprovePreparedWorkspaceGrant>(() => new Promise(() => {}));
    const f = setup('agent', undefined, approve);
    const params = {
      ...f.params,
      permissions: { network: null, fileSystem: { read: null, write: ['/prepared/task'] } },
    };
    const pending = f.handler(
      'item/permissions/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    f.controller.abort();
    expect(await pending).toEqual({ permissions: {}, scope: 'turn' });
    expect(f.sent).toEqual([]);
  });

  it('never calls prepared-root approval for unrelated scope or a protected root', async () => {
    const approve = vi.fn<ApprovePreparedWorkspaceGrant>(async () => undefined);
    const f = setup('agent', undefined, approve);
    const params = {
      ...f.params,
      permissions: { network: null, fileSystem: { read: null, write: ['/credentials/child'] } },
    };
    expect(
      await f.handler('item/permissions/requestApproval', params, f.controller.signal, f.context),
    ).toEqual({ permissions: {}, scope: 'turn' });
    const expanded = f.handler(
      'item/permissions/requestApproval',
      {
        ...f.params,
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ['/unrelated'], write: ['/prepared/task'] },
        },
      },
      f.controller.signal,
      f.context,
    );
    resolvePending(await request(f), 'deny', undefined, 'session');
    expect(await expanded).toEqual({ permissions: {}, scope: 'turn' });
    expect(approve).not.toHaveBeenCalled();
  });

  it('shows the exact Ask boundary and returns the actual upstream turn grant once', async () => {
    const f = setup('ask');
    const result = f.handler(
      'item/permissions/requestApproval',
      f.params,
      f.controller.signal,
      f.context,
    );
    const id = await request(f);
    expect(f.sent[0]).toMatchObject({ approvalScope: 'session' });
    expect(f.sent[0].allowSessionGrant).not.toBe(false);
    const display = JSON.parse(f.sent[0].toolInput as string);
    expect(display).toMatchObject({
      runtimeId: 'owned-runtime',
      environmentId: 'local',
      requestId: 'rpc',
      method: 'item/permissions/requestApproval',
      params: f.params,
    });
    expect(resolvePending(id, 'once', undefined, 'session')).toBe(true);
    expect(await result).toEqual({
      permissions: { fileSystem: permissions.fileSystem },
      scope: 'turn',
    });
    expect(resolvePending(id, 'once', undefined, 'session')).toBe(false);
    expect(getPendingRequestsBySession('session')).toEqual([]);
    expect(f.fences.length).toBe(1);
  });

  it('returns an explicit session grant for only the displayed permission profile', async () => {
    const f = setup();
    const result = f.handler(
      'item/permissions/requestApproval',
      f.params,
      f.controller.signal,
      f.context,
    );
    const id = await request(f);
    expect(f.sent[0].sessionGrantDescription).toContain('native thread');
    resolvePending(id, 'always', undefined, 'session');
    expect(await result).toEqual({
      permissions: { fileSystem: permissions.fileSystem },
      scope: 'session',
    });
    expect(f.registry.get('client')!.sessionAllowList.size).toBe(0);
  });

  it('keeps command approval and additional filesystem permissions in the same exact operation', async () => {
    const f = setup('auto');
    const params = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'command',
      startedAtMs: Date.now(),
      kind: 'command',
      environmentId: 'local',
      command: 'touch /extra/write/file',
      cwd: '/workspace',
      additionalPermissions: permissions,
      availableDecisions: ['accept', 'decline'],
    };
    const result = f.handler(
      'item/commandExecution/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    const id = await request(f);
    expect(f.sent[0].description).toContain(
      'Automatic review is not yet qualified for this account and runtime',
    );
    expect(f.sent[0].description).toContain('Human review');
    expect(JSON.parse(f.sent[0].toolInput as string).params).toEqual(params);
    resolvePending(id, 'always', undefined, 'session');
    expect(await result).toEqual({ decision: 'accept' });
    expect(f.registry.get('client')!.sessionAllowList.size).toBe(0);
  });

  it.each(['deny', 'cancel'] as const)(
    'returns the pinned command %s response without native execution',
    async (decision) => {
      const f = setup();
      const params = {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'command',
        startedAtMs: Date.now(),
        kind: 'command',
        environmentId: 'local',
        command: 'touch /extra/write/file',
        additionalPermissions: permissions,
      };
      const result = f.handler(
        'item/commandExecution/requestApproval',
        params,
        f.controller.signal,
        f.context,
      );
      const id = await request(f);
      if (decision === 'cancel') f.controller.abort();
      else resolvePending(id, 'deny', undefined, 'session');
      expect(await result).toEqual({ decision: decision === 'cancel' ? 'cancel' : 'decline' });
    },
  );

  it('reviews source-faithful managed network context even when no command is sent', async () => {
    const f = setup();
    const params = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'network',
      startedAtMs: Date.now(),
      kind: 'command',
      environmentId: 'local',
      command: null,
      cwd: null,
      commandActions: null,
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
      availableDecisions: ['accept', 'acceptForSession', 'cancel'],
    };
    const result = f.handler(
      'item/commandExecution/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    resolvePending(await request(f), 'once', undefined, 'session');
    expect(await result).toEqual({ decision: 'accept' });
    expect(JSON.parse(f.sent[0].toolInput as string).params).toEqual(params);
  });

  it('does not convert a network amendment-only offer into an ordinary command accept', async () => {
    const f = setup();
    const params = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'network',
      startedAtMs: Date.now(),
      kind: 'command',
      environmentId: 'local',
      networkApprovalContext: { host: 'example.test', protocol: 'https' },
      availableDecisions: [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'example.test', action: 'allow' },
          },
        },
        'cancel',
      ],
    };
    expect(
      await f.handler(
        'item/commandExecution/requestApproval',
        params,
        f.controller.signal,
        f.context,
      ),
    ).toEqual({ decision: 'cancel' });
    expect(f.sent).toEqual([]);
  });

  it('keeps distinct stdin callback approvals on the same native item separate', async () => {
    const f = setup();
    const params = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'terminal',
      startedAtMs: Date.now(),
      kind: 'writeStdin',
      environmentId: 'local',
      command: "write_stdin --session-id 1000 'answer\n'",
      availableDecisions: ['accept', 'cancel'],
    };
    const first = f.handler(
      'item/commandExecution/requestApproval',
      { ...params, approvalId: 'callback-a' },
      f.controller.signal,
      { ...f.context, requestId: 'rpc-a' },
    );
    const second = f.handler(
      'item/commandExecution/requestApproval',
      { ...params, approvalId: 'callback-b' },
      f.controller.signal,
      { ...f.context, requestId: 'rpc-b' },
    );
    await vi.waitFor(() =>
      expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(2),
    );
    const cards = f.sent.filter((event) => event.type === 'permission_request');
    expect(cards.map((card) => JSON.parse(card.toolInput as string).params.approvalId)).toEqual([
      'callback-a',
      'callback-b',
    ]);
    resolvePending(cards[0].permId as string, 'once', undefined, 'session');
    resolvePending(cards[1].permId as string, 'deny', undefined, 'session');
    expect(await first).toEqual({ decision: 'accept' });
    expect(await second).toEqual({ decision: 'cancel' });
  });

  it.each(['deny', 'cancel', 'expired', 'stale'] as const)(
    'never grants on %s',
    async (outcome) => {
      const f = setup('agent', 50);
      const result = f.handler(
        'item/permissions/requestApproval',
        f.params,
        f.controller.signal,
        f.context,
      );
      const id = await request(f);
      if (outcome === 'cancel') f.controller.abort();
      else if (outcome === 'expired') await new Promise((resolve) => setTimeout(resolve, 60));
      else {
        if (outcome === 'stale') f.revoke();
        resolvePending(id, outcome === 'deny' ? 'deny' : 'once', undefined, 'session');
      }
      expect(await result).toEqual({ permissions: {}, scope: 'turn' });
      expect(getPendingRequestsBySession('session')).toEqual([]);
    },
  );

  it('declines stale thread, remote environment, invalid wire parameters and unavailable session', async () => {
    const f = setup();
    for (const params of [
      { ...f.params, threadId: 'other' },
      { ...f.params, environmentId: 'remote' },
      { ...f.params, environmentId: null },
      { ...f.params, permissions: { broad: true } },
    ]) {
      expect(
        await f.handler('item/permissions/requestApproval', params, f.controller.signal, f.context),
      ).toEqual({ permissions: {}, scope: 'turn' });
    }
    f.registry.dispose();
    expect(
      await f.handler('item/permissions/requestApproval', f.params, f.controller.signal, f.context),
    ).toEqual({ permissions: {}, scope: 'turn' });
    expect(f.sent).toEqual([]);
  });

  it.each([
    { read: ['/credentials/auth.json'], write: null },
    { read: ['/credentials/..hidden/auth.json'], write: null },
    { read: ['/'], write: null },
    { read: null, write: ['/credentials/nested/file'] },
    { read: null, write: ['/authority/publication'] },
    { read: null, write: ['/'] },
    {
      read: null,
      write: null,
      entries: [{ path: { type: 'glob_pattern', pattern: '/**' }, access: 'read' }],
    },
    {
      read: null,
      write: null,
      entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'write' }],
    },
  ])(
    'declines permission overlays that can weaken the protected filesystem: %j',
    async (fileSystem) => {
      const f = setup();
      const scoped = { network: null, fileSystem };
      expect(
        await f.handler(
          'item/permissions/requestApproval',
          { ...f.params, permissions: scoped },
          f.controller.signal,
          f.context,
        ),
      ).toEqual({ permissions: {}, scope: 'turn' });
      const command = {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'cmd',
        kind: 'command',
        startedAtMs: Date.now(),
        environmentId: 'local',
        command: 'cat /credentials/auth.json',
        additionalPermissions: scoped,
      };
      expect(
        await f.handler(
          'item/commandExecution/requestApproval',
          command,
          f.controller.signal,
          f.context,
        ),
      ).toEqual({ decision: 'decline' });
      expect(f.sent).toEqual([]);
    },
  );

  it('declines symlink permission grants into a credential root', async () => {
    const f = setup();
    const directory = mkdtempSync(join(tmpdir(), 'mitzo-native-grant-'));
    try {
      const denied = join(directory, 'credentials');
      mkdirSync(denied);
      const link = join(directory, 'elsewhere');
      symlinkSync(denied, link);
      const handler = createCodexNativeApprovalHandler({
        registry: f.registry,
        clientId: 'client',
        runtimeId: 'runtime',
        environmentId: 'local',
        deniedRoots: [denied],
        writeProtectedRoots: [],
      });
      expect(
        await handler(
          'item/permissions/requestApproval',
          {
            ...f.params,
            permissions: {
              network: null,
              fileSystem: { read: [join(link, 'auth.json')], write: null },
            },
          },
          f.controller.signal,
          f.context,
        ),
      ).toEqual({ permissions: {}, scope: 'turn' });
      expect(f.sent).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks path identity again if an ancestor changes while permission review waits', async () => {
    const f = setup();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-native-grant-')));
    try {
      const denied = join(directory, 'credentials');
      const safe = join(directory, 'safe');
      mkdirSync(denied);
      mkdirSync(safe);
      const handler = createCodexNativeApprovalHandler({
        registry: f.registry,
        clientId: 'client',
        runtimeId: 'runtime',
        environmentId: 'local',
        deniedRoots: [denied],
        writeProtectedRoots: [],
      });
      const result = handler(
        'item/permissions/requestApproval',
        { ...f.params, permissions: { network: null, fileSystem: { read: [safe], write: null } } },
        f.controller.signal,
        f.context,
      );
      const id = await request(f);
      renameSync(safe, join(directory, 'retained-safe'));
      symlinkSync(denied, safe);
      resolvePending(id, 'once', undefined, 'session');
      expect(await result).toEqual({ permissions: {}, scope: 'turn' });
      expect(f.fences[0]).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the exact authoritative file list and rejects protected file changes', async () => {
    const f = setup();
    const params = { threadId: 'thread', turnId: 'turn', itemId: 'file', startedAtMs: Date.now() };
    for (const fileChangePaths of [
      undefined,
      [],
      ['/credentials/auth.json'],
      ['/authority/bundle'],
    ]) {
      expect(
        await f.handler('item/fileChange/requestApproval', params, f.controller.signal, {
          ...f.context,
          fileChangePaths,
        }),
      ).toEqual({ decision: 'decline' });
    }
    expect(f.sent).toEqual([]);
  });

  it('grants one exact file change without relying on the unstable grantRoot field', async () => {
    const f = setup('ask');
    const params = { threadId: 'thread', turnId: 'turn', itemId: 'file', startedAtMs: Date.now() };
    const result = f.handler(
      'item/fileChange/requestApproval',
      params,
      f.controller.signal,
      f.context,
    );
    resolvePending(await request(f), 'once', undefined, 'session');
    expect(await result).toEqual({ decision: 'accept' });
    expect(JSON.parse(f.sent[0].toolInput as string).fileChangePaths).toEqual(
      f.context.fileChangePaths,
    );
    expect(
      await f.handler(
        'item/fileChange/requestApproval',
        { ...params, grantRoot: '/outside' },
        f.controller.signal,
        f.context,
      ),
    ).toEqual({ decision: 'decline' });
  });
});
