import { describe, expect, it, vi } from 'vitest';
import { createTerminalTargetResolver } from '../terminal-targets.js';
const meta = {
  title: 'Chat A',
  cwd: '/sandbox/workspaces/task',
  accountBinding: {
    accountId: 'a',
    provider: 'openai',
    model: 'luna',
    accountLabel: 'Work',
    profileRevision: 'v1',
  },
};
const runtime = {
  sandboxName: 'original',
  sandboxId: 'native-original',
  workdir: meta.cwd,
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  cli: 'openshell',
  gateway: 'g',
  workspace: 'default',
  gatewayInsecure: false,
};
const deps = () => ({
  hostCwd: '/home/operator',
  session: vi.fn(() => meta),
  allowedHost: vi.fn(() => false),
  remote: vi.fn(() => true),
  runtime: vi.fn(() => ({
    runtime,
    route: { kind: 'api' as const, provider: 'work', model: 'luna' },
  })),
  currentRoute: vi.fn(() => ({ kind: 'api' as const, provider: 'work', model: 'luna' })),
  validateRuntime: vi.fn(),
  inspect: vi.fn(async () => ({ id: runtime.sandboxId, phase: 'Ready' })),
});
describe('terminal destinations', () => {
  it('opens the Mac independently of account or conversation', async () => {
    const d = deps();
    const value = await createTerminalTargetResolver(d)({}, 'operator');
    expect(value).toMatchObject({ kind: 'host', cwd: d.hostCwd, label: 'Your Mac' });
    expect(d.runtime).not.toHaveBeenCalled();
  });
  it('pins the persisted original sandbox and verifies physical availability', async () => {
    const d = deps();
    const value = await createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator');
    expect(value).toMatchObject({ kind: 'sandbox', sessionId: 'chat-a', runtime });
    expect(d.inspect).toHaveBeenCalledWith('chat-a', runtime, expect.anything());
  });
  it.each(['Deleted', 'Stopped', 'Error'])(
    'refuses a %s sandbox without falling back to the host',
    async (phase) => {
      const d = deps();
      d.inspect.mockResolvedValue({ id: runtime.sandboxId, phase });
      await expect(
        createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator'),
      ).rejects.toThrow('Sandbox terminal unavailable');
    },
  );
  it('refuses a replacement resource under the same sandbox name', async () => {
    const d = deps();
    d.inspect.mockResolvedValue({ id: 'replacement', phase: 'Ready' });
    await expect(
      createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator'),
    ).rejects.toThrow('Sandbox terminal unavailable');
  });
  it('refuses a chat whose provider binding no longer matches its workspace receipt', async () => {
    const d = deps();
    d.currentRoute.mockReturnValue({ kind: 'api', provider: 'changed', model: 'luna' });
    await expect(
      createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator'),
    ).rejects.toThrow('Sandbox binding changed');
  });
  it('requires a configured local workspace for a host chat', async () => {
    const d = deps();
    d.remote.mockReturnValue(false);
    await expect(
      createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator'),
    ).rejects.toThrow('Chat workspace unavailable');
  });
});

it('does not map a multi-agent conversation to the host when its sandbox is ambiguous', async () => {
  const d = deps();
  d.session.mockReturnValue({ ...d.session(), sessionType: 'symposium' } as never);
  d.remote.mockReturnValue(false);
  d.allowedHost.mockReturnValue(true);
  await expect(
    createTerminalTargetResolver(d)({ sessionId: 'chat-a' }, 'operator'),
  ).rejects.toThrow('agent');
  expect(d.inspect).not.toHaveBeenCalled();
});
