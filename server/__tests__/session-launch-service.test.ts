import { afterEach, expect, it, vi } from 'vitest';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { SessionLaunchStore } from '../session-launch-store.js';
import { SessionLaunchService, type SessionLaunchPort } from '../session-launch-service.js';

const stores: SessionLaunchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const configuration = {
  version: 1,
  runtime: {
    version: 1,
    account: null,
    agentProfile: null,
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
} as SessionLaunchConfig;
const edits = { title: 'Reviewed launch', prompt: 'Reviewed prompt', configuration };
function fixture() {
  const store = new SessionLaunchStore(':memory:');
  stores.push(store);
  const port: SessionLaunchPort = {
    validate: vi.fn(async () => {}),
    start: vi.fn(async (_record, _authority, prepared) => {
      prepared('child', 'preparation');
    }),
    inspect: vi.fn(async () => ({ accepted: true })),
  };
  const service = new SessionLaunchService(store, port);
  const record = store.propose({
    ...edits,
    operatorId: 'user',
    sourceSessionId: 'parent',
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  const authority = {
    operatorConnectionId: 'authenticated-operation',
    authSessionId: 'login',
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
  return { store, port, service, record, authority };
}
it('keeps unsupported selections editable and allocates nothing before user approval', async () => {
  const f = fixture();
  vi.mocked(f.port.validate).mockRejectedValue(Error('Unsupported settings'));
  await expect(
    f.service.approve(f.record.proposalId, 'user', edits, f.record.revision, f.authority),
  ).rejects.toThrow('Unsupported');
  expect(f.store.get(f.record.proposalId, 'user').state).toBe('pending');
  expect(f.port.start).not.toHaveBeenCalled();
  expect(f.store.get(f.record.proposalId, 'user').allocationId).toBeNull();
});
it('starts the approved edited prompt once under concurrent duplicate approvals', async () => {
  const f = fixture();
  const reviewed = { ...edits, prompt: 'User-edited prompt' };
  await Promise.all([
    f.service.approve(f.record.proposalId, 'user', reviewed, 1, f.authority),
    f.service.approve(f.record.proposalId, 'user', reviewed, 1, f.authority),
  ]);
  expect(f.port.start).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.port.start).mock.calls[0][0]).toMatchObject({
    prompt: reviewed.prompt,
    allocationId: expect.any(String),
    commandId: expect.any(String),
  });
  expect(f.store.get(f.record.proposalId, 'user')).toMatchObject({
    state: 'running',
    childSessionId: 'child',
  });
});
it('reconciles a lost acknowledgement from authoritative command receipts without replay', async () => {
  const f = fixture();
  vi.mocked(f.port.start).mockRejectedValue(Error('Provider response lost'));
  const uncertain = await f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority);
  expect(uncertain.state).toBe('uncertain');
  vi.mocked(f.port.inspect).mockResolvedValue({
    accepted: true,
    childSessionId: 'retained-child',
    preparationId: 'retained-preparation',
  });
  const recovered = await f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority);
  expect(recovered).toMatchObject({ state: 'running', childSessionId: 'retained-child' });
  expect(f.port.start).toHaveBeenCalledTimes(1);
});
it('does not launch after cancellation or revoked operator authority', async () => {
  const f = fixture();
  f.store.cancel(f.record.proposalId, 'user', 1);
  await expect(
    f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority),
  ).rejects.toThrow('cancelled');
  expect(f.port.start).not.toHaveBeenCalled();
  f.authority.assertCurrent.mockImplementation(() => {
    throw Error('Revoked');
  });
  await expect(
    f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority),
  ).rejects.toThrow('Revoked');
});
it('surfaces missing startup receipts as uncertain without repeating workspace effects', async () => {
  const f = fixture();
  f.store.approve(f.record.proposalId, 'user', edits, 1);
  expect(f.store.claimStart(f.record.proposalId)).toBe(true);
  vi.mocked(f.port.inspect).mockResolvedValue({ accepted: false, uncertain: true });
  const result = await f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority);
  expect(result.state).toBe('uncertain');
  expect(f.port.start).not.toHaveBeenCalled();
});
it('resumes an interrupted startup once under concurrent explicit requests with the original IDs', async () => {
  const f = fixture();
  const approved = f.store.approve(f.record.proposalId, 'user', edits, 1);
  f.store.claimStart(f.record.proposalId);
  const interrupted = f.store.fail(f.record.proposalId, 'Controller interrupted', true);
  f.port.canResume = vi.fn(async () => {});
  f.port.resume = vi.fn(async (retained, _authority, prepared) => {
    expect(retained.allocationId).toBe(approved.allocationId);
    expect(retained.commandId).toBe(approved.commandId);
    prepared('child', 'preparation');
  });
  const results = await Promise.allSettled([
    f.service.resume(f.record.proposalId, 'user', interrupted.revision, f.authority),
    f.service.resume(f.record.proposalId, 'user', interrupted.revision, f.authority),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.port.resume).toHaveBeenCalledOnce();
  expect(f.port.start).not.toHaveBeenCalled();
});
