import { expect, it, vi } from 'vitest';
import { assertRepositoryTaskRetirement } from '../repository-task-retirement.js';
import type { RepositoryWorkspace } from '../repository-workspaces.js';

function fixture(implementation = 'codex') {
  const binding = {
    accountId: 'account',
    provider: 'openai',
    model: 'offline',
    profileRevision: 'one',
  };
  const record = {
    id: 'workspace',
    binding,
    conversationId: 'conversation',
    directory: '/tasks/checkout',
    taskIdentity: { directory: '/tasks/checkout' },
  } as RepositoryWorkspace;
  const session = {
    sessionId: 'conversation',
    cwd: record.directory,
    repositoryWorkspaceId: record.id,
    accountBinding: binding,
    isActive: false,
    executionPhase: 'TERMINAL',
  };
  const owners = {
    events: {
      getSession: vi.fn(() => session),
      assertNoOtherWorkspaceReferences: vi.fn(),
      getSessionRuntimeBinding: vi.fn(() => ({
        execution: { location: 'local' },
        harness: { implementation },
      })),
      hasUncertainOrdinaryCommand: vi.fn(() => false),
      getEventsOfType: vi.fn(() => [] as Array<{ payload: { policy: string } }>),
      getPendingOrdinaryLocalVertexCommandIds: vi.fn(() => [] as string[]),
    },
    registry: { findBySessionId: vi.fn(() => undefined as unknown) },
    assertNativeStopped: vi.fn(),
    protectedDirectories: ['/application/release'],
  };
  return { record, session, owners };
}
it('allows an exact stopped local task only after its native owner proves no pending work', () => {
  const f = fixture();
  expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).not.toThrow();
  expect(f.owners.assertNativeStopped).toHaveBeenCalledWith(f.record);
  f.owners.assertNativeStopped.mockImplementation(() => {
    throw Error('unsettled native turn');
  });
  expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).toThrow();
});
it.each(['active', 'live', 'uncertain', 'external', 'wrong-workspace', 'release'])(
  'protects a task when its current state is %s',
  (reason) => {
    const f = fixture();
    if (reason === 'active') f.session.isActive = true;
    if (reason === 'live') f.owners.registry.findBySessionId.mockReturnValue({});
    if (reason === 'uncertain') f.owners.events.hasUncertainOrdinaryCommand.mockReturnValue(true);
    if (reason === 'external')
      f.owners.events.getEventsOfType.mockReturnValue([{ payload: { policy: 'external-owner' } }]);
    if (reason === 'wrong-workspace') f.session.repositoryWorkspaceId = 'other';
    if (reason === 'release') f.owners.protectedDirectories = ['/tasks/checkout/runtime'];
    expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).toThrow();
    expect(f.owners.assertNativeStopped).not.toHaveBeenCalled();
  },
);
it('checks the durable Vertex queue and refuses unknown provider owners', () => {
  const f = fixture('claude-sdk');
  expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).not.toThrow();
  expect(f.owners.assertNativeStopped).not.toHaveBeenCalled();
  f.owners.events.getPendingOrdinaryLocalVertexCommandIds.mockReturnValue(['queued']);
  expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).toThrow();
  const unknown = fixture('unknown');
  expect(() => assertRepositoryTaskRetirement(unknown.record, unknown.owners as never)).toThrow();
});

it('protects a stopped owner whose workspace is retained by another conversation', () => {
  const f = fixture();
  f.owners.events.assertNoOtherWorkspaceReferences.mockImplementation(() => {
    throw Error('Retained peer workspace reference');
  });
  expect(() => assertRepositoryTaskRetirement(f.record, f.owners as never)).toThrow(/reference/);
  expect(f.owners.assertNativeStopped).not.toHaveBeenCalled();
});
