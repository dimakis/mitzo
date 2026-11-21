import { expect, it, vi } from 'vitest';
import { readPrMonitorExecution } from '../pr-monitor-application.js';
const binding = {
  version: 2,
  account: { accountId: 'a', provider: 'openai-codex', profileRevision: '1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: '1' },
} as const;
function fixture() {
  const meta = {
    sessionId: 'chat',
    cwd: '/task',
    mode: 'agent',
    repositoryWorkspaceId: 'w',
    accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'm' },
  };
  const admission = {
    binding,
    selection: {
      permission: { mode: 'agent' },
      agent: { profileId: 'default', revision: 1 },
      model: 'm',
    },
    workspace: { workspaceId: 'w', cwd: '/task' },
    state: 'consumed',
  };
  const store = {
    getSession: () => meta,
    getSessionRuntimeBinding: () => binding,
    getLatestOrdinaryCommandAdmission: () => admission,
    removals: { assertAdmissible: vi.fn() },
  };
  const registry = {
    findBySessionId: () => undefined,
    isUserClose: () => false,
    isClosingOut: () => false,
  };
  const accounts = { resume: vi.fn((b) => b) };
  return {
    meta,
    admission,
    store,
    registry,
    accounts,
    read: () =>
      readPrMonitorExecution(store as never, registry as never, accounts as never, 'chat'),
  };
}
it('uses retained ordinary admission without needing an attached browser or starting a runtime', () => {
  const f = fixture();
  expect(f.read()).toMatchObject({ binding, workspaceId: 'w' });
  expect(f.accounts.resume).toHaveBeenCalledWith(f.meta.accountBinding);
  expect(f.store.removals.assertAdmissible).toHaveBeenCalledWith('chat');
});
it.each(['workspace', 'mode', 'account', 'stopped', 'removed', 'admission'] as const)(
  'rejects a changed %s owner before a background read',
  (reason) => {
    const f = fixture();
    if (reason === 'workspace') f.meta.cwd = '/other';
    if (reason === 'mode') f.meta.mode = 'ask';
    if (reason === 'account')
      f.accounts.resume.mockImplementation(() => {
        throw Error('account gone');
      });
    if (reason === 'stopped') Object.assign(f.meta, { closedBy: 'user' });
    if (reason === 'removed')
      f.store.removals.assertAdmissible.mockImplementation(() => {
        throw Error('removal pending');
      });
    if (reason === 'admission') f.admission.state = 'reserved';
    expect(() => f.read()).toThrow('conversation_unavailable');
  },
);
