import { expect, it, vi } from 'vitest';
import { createLocalSessionRemoval } from '../local-session-removal.js';

function fixture(linkedGit = false) {
  const record = {
    id: 'workspace',
    conversationId: 'chat',
    directory: '/task',
    binding: { accountId: 'a' },
    taskIdentity: { linkedGit },
  };
  const events = {
    getSession: () => ({ sessionId: 'chat', cwd: '/task', repositoryWorkspaceId: 'workspace' }),
  };
  const workspaces = {
    getForConversation: () => record,
    retireTask: vi.fn(async () => {
      Object.assign(record, { retirement: { receipt: { state: 'retired' } } });
    }),
  };
  const assertStopped = vi.fn(),
    current = vi.fn();
  const service = createLocalSessionRemoval({
    events,
    workspaces: () => workspaces,
    assertStopped,
    resolveBinding: () => record.binding,
  } as never);
  return { service, record, workspaces, assertStopped, current };
}
it('retires an independently owned checkout under the existing preservation owner', async () => {
  const f = fixture();
  expect(f.service.preview('chat').action).toBe('retire');
  await f.service.release('chat', f.current);
  expect(f.workspaces.retireTask).toHaveBeenCalledWith(
    'workspace',
    f.record.binding,
    expect.objectContaining({
      assertCurrent: expect.any(Function),
      assertTaskStopped: expect.any(Function),
    }),
  );
});
it('explicitly retains linked worktrees instead of claiming disk reclamation', async () => {
  const f = fixture(true);
  expect(f.service.preview('chat')).toMatchObject({
    action: 'retain',
    reason: expect.stringMatching(/disk space/),
  });
  await f.service.release('chat', f.current);
  expect(f.workspaces.retireTask).not.toHaveBeenCalled();
});
it('invalidates review if workspace custody changes from retention to retirement', () => {
  const f = fixture(true);
  const before = f.service.fingerprint('chat');
  f.record.taskIdentity.linkedGit = false;
  expect(f.service.fingerprint('chat')).not.toBe(before);
});
