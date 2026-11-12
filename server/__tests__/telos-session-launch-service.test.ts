import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { SessionLaunchError, SessionLaunchStore } from '../session-launch-store.js';
import {
  SessionLaunchService,
  type SessionLaunchPort,
  type TelosSessionLaunchPort,
} from '../session-launch-service.js';

/** First delivery contract. These tests precede implementation and have not
 * been executed: the task execution approval expired before the red phase.
 * A work-aware port composes reviewed role setup, never ordinary startup plus
 * post-fact attachment. It returns only verified canonical assignment receipts.
 */
const stores: SessionLaunchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const configuration: SessionLaunchConfig = {
  version: 1,
  runtime: {
    version: 1,
    account: null,
    agentProfile: null,
    execution: { location: 'local', targetId: 'selected-child-host' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const edits = { title: 'Capability baseline lead', prompt: 'Reviewed handoff', configuration };
const telos = {
  version: 1 as const,
  parentItemId: 'capability-outcome',
  parentAssignmentRevision: 3,
  itemId: 'capability-baseline',
  expectedRevision: 'a'.repeat(64),
  role: 'lead' as const,
  sourceSnapshotIds: [],
  artifactRefs: [],
};

function fixture() {
  const store = new SessionLaunchStore(':memory:');
  stores.push(store);
  const ordinary: SessionLaunchPort = {
    validate: vi.fn(async () => {}),
    start: vi.fn(async () => {
      throw Error('A work-bound request must never use ordinary StartSession');
    }),
    inspect: vi.fn(async () => ({ accepted: true })),
  };
  const assigned = {
    state: 'assigned' as const,
    childSessionId: 'distinct-feature-lead',
    preparationId: 'original-preparation',
    itemId: telos.itemId,
    role: telos.role,
    assignmentRevision: 1,
    execution: 'not_started' as const,
  };
  const work: TelosSessionLaunchPort = {
    validate: vi.fn(async () => {}),
    create: vi.fn(async () => assigned),
    inspect: vi.fn(async () => assigned),
  };
  const service = new SessionLaunchService(store, ordinary, work);
  const proposal = {
    ...edits,
    operatorId: 'user',
    sourceSessionId: 'assigned-outcome-orchestrator',
    requestId: 'a1159a0d-b87f-4ca8-a3d1-5dffb0aeac4d',
    telos,
  };
  const record = store.propose(proposal);
  const authority = {
    operatorConnectionId: 'reviewing-connection',
    authSessionId: 'reviewing-login',
    signal: new AbortController().signal,
    assertCurrent: vi.fn(),
  };
  return { store, ordinary, work, service, proposal, record, assigned, authority };
}

describe('Telos create-and-assign through originating session review', () => {
  it('retains the exact work binding in the request and rejects changed duplicate identities', () => {
    const f = fixture();
    expect(f.record).toMatchObject({ state: 'pending', telos, childSessionId: null });
    expect(f.store.propose(f.proposal)).toEqual(f.record);
    expect(() =>
      f.store.propose({ ...f.proposal, telos: { ...telos, itemId: 'different-feature' } }),
    ).toThrow('identity changed');
    expect(f.work.create).not.toHaveBeenCalled();
  });

  it('includes host-derived work scope even when the original agent input is retained', () => {
    const f = fixture();
    const proposal = {
      ...f.proposal,
      requestId: 'afe24311-d2f0-4a30-8190-91af30e2b366',
      originalInput: { itemId: telos.itemId },
    };
    f.store.propose(proposal);
    expect(() =>
      f.store.propose({ ...proposal, telos: { ...telos, parentAssignmentRevision: 4 } }),
    ).toThrow('identity changed');
  });

  it('refuses ordinary prepared/running transitions for work-bound creation', () => {
    const f = fixture();
    f.store.approve(f.record.proposalId, 'user', edits, 1);
    expect(() => f.store.markPrepared(f.record.proposalId, 'child', 'preparation')).toThrow(
      /work-bound/i,
    );
    f.store.markAssigned(f.record.proposalId, 'child', 'preparation');
    expect(() => f.store.markRunning(f.record.proposalId)).toThrow();
  });

  it('creates one assigned session under concurrent approvals without admitting a command', async () => {
    const f = fixture();
    await Promise.all([
      f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority),
      f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority),
    ]);
    expect(f.work.create).toHaveBeenCalledTimes(1);
    expect(f.store.get(f.record.proposalId, 'user')).toMatchObject({
      state: 'assigned',
      childSessionId: f.assigned.childSessionId,
      commandId: null,
      telos,
    });
    expect(f.ordinary.start).not.toHaveBeenCalled();
    expect(f.ordinary.inspect).not.toHaveBeenCalled();
  });

  it('validates the work scope and selected child configuration before effects', async () => {
    const f = fixture();
    vi.mocked(f.work.validate).mockRejectedValue(
      new SessionLaunchError('The originating lead was replaced. Review with the current lead.'),
    );
    await expect(
      f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority),
    ).rejects.toMatchObject({
      code: 'session_launch_preflight_refused',
      effectStatus: 'not_started',
    });
    expect(f.work.validate).toHaveBeenCalledWith(f.record, edits, f.authority);
    expect(f.store.get(f.record.proposalId, 'user')).toMatchObject({
      state: 'pending',
      allocationId: null,
      commandId: null,
    });
    expect(f.work.create).not.toHaveBeenCalled();
    expect(f.ordinary.start).not.toHaveBeenCalled();
  });

  it('recovers a lost assignment response without allocating again or reporting execution', async () => {
    const f = fixture();
    vi.mocked(f.work.create).mockRejectedValueOnce(Error('Assignment committed; response lost'));
    const uncertain = await f.service.approve(f.record.proposalId, 'user', edits, 1, f.authority);
    expect(uncertain.state).toBe('uncertain');
    // A new service instance has no in-memory knowledge of the first attempt.
    const restarted = new SessionLaunchService(f.store, f.ordinary, f.work);
    const recovered = await restarted.refresh(f.record.proposalId, 'user', f.authority);
    expect(recovered).toMatchObject({
      state: 'assigned',
      childSessionId: f.assigned.childSessionId,
      commandId: null,
    });
    expect(await restarted.refresh(f.record.proposalId, 'user', f.authority)).toEqual(recovered);
    expect(f.work.create).toHaveBeenCalledTimes(1);
    expect(f.ordinary.start).not.toHaveBeenCalled();
    expect(f.ordinary.inspect).not.toHaveBeenCalled();
  });
});
