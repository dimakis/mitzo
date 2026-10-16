import { beforeEach, expect, it, vi } from 'vitest';
import type { TerminalRecord } from '../terminal-service.js';
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.execute }),
}));
import { TmuxTerminalBackend } from '../terminal-backend.js';
import { TerminalSessionMissing } from '../terminal-errors.js';
const namespace = 'mitzo-missing-socket-test';
const record: TerminalRecord = {
  id: 'term-01234567-1234-1234-1234-123456789abc',
  owner: 'fixture',
  identity: 'host',
  kind: 'host',
  label: 'Fixture',
  cwd: '/tmp',
  state: 'running',
  createdAt: 1,
};
beforeEach(() => {
  mocks.execute.mockReset();
});
it('treats an already removed owned tmux socket as successful idempotent cleanup', async () => {
  mocks.execute.mockRejectedValue({
    code: 1,
    stderr: `error connecting to /tmp/tmux-1001/${namespace} (No such file or directory)\n`,
  });
  await expect(new TmuxTerminalBackend(namespace).end(record)).resolves.toBeUndefined();
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.execute.mock.calls[0][1]).toContain('kill-session');
});
it('classifies a missing socket as an absent resumed session without creating another shell', async () => {
  mocks.execute.mockRejectedValue({
    code: 1,
    stderr: `error connecting to /tmp/tmux-1001/${namespace} (No such file or directory)`,
  });
  await expect(
    new TmuxTerminalBackend(namespace).start(record, true, { data: vi.fn(), exit: vi.fn() }),
  ).rejects.toBeInstanceOf(TerminalSessionMissing);
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.execute.mock.calls[0][1]).toContain('has-session');
});
it.each([
  {
    code: 1,
    stderr: 'error connecting to /tmp/tmux-1001/another-owner (No such file or directory)',
  },
  { code: 1, stderr: `error connecting to /tmp/tmux-1001/${namespace} (Permission denied)` },
  {
    code: 255,
    stderr: `error connecting to /tmp/tmux-1001/${namespace} (No such file or directory)`,
  },
  { code: 'ENOENT', stderr: 'tmux executable missing' },
  {
    code: 1,
    stderr: `unrelated failure\nerror connecting to /tmp/tmux-1001/${namespace} (No such file or directory)`,
  },
])('keeps ambiguous transport failures explicit and redacted: %j', async (error) => {
  mocks.execute.mockRejectedValue({ ...error, message: 'secret SSH grant must not escape' });
  await expect(new TmuxTerminalBackend(namespace).end(record)).rejects.toThrow(
    /^Terminal cleanup unavailable$/,
  );
});
