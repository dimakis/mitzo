import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import {
  SessionService,
  childInputHash,
  type ChildRuntime,
  type ChildCreateRequest,
} from '../session-service.js';

const binding = {
  accountId: 'account-a',
  accountLabel: 'Account A',
  provider: 'openai-codex',
  model: 'gpt-6-luna',
  profileRevision: 'rev-1',
};

describe('SessionService', () => {
  let dir: string;
  let dbPath: string;
  let events: EventStore;
  let service: SessionService;
  let observed: string[];
  let runtime: ChildRuntime;
  let currentAuthority: ReturnType<typeof authority> | null;

  const authority = () => ({
    parentConversationId: 'parent',
    parentActive: true,
    grantId: 'grant-a',
    grantRevision: 1,
    accountBinding: binding,
    reasoningEffort: 'medium',
    taskRootId: 'root',
    taskNodeId: undefined as string | undefined,
    planRevision: 'plan-1',
    allowedFiles: ['src/**'],
    allowedCapabilities: ['read'],
    maxChildren: 2,
    maxConcurrent: 1,
    maxDepth: 2,
    maxSpawnsPerMinute: 2,
  });
  const request = (key = 'task-1') => {
    const input = {
      parentConversationId: 'parent',
      idempotencyKey: key,
      prompt: 'Do the bounded task',
      taskRootId: 'root',
      taskNodeId: key,
      planRevision: 'plan-1',
      grantId: 'grant-a',
      grantRevision: 1,
      accountBinding: binding,
      reasoningEffort: 'medium',
      scope: { files: ['src/**'], capabilities: ['read'] },
      isolation: 'independent' as const,
    };
    return { ...input, inputHash: childInputHash(input) };
  };
  const rehash = (input: ChildCreateRequest) => ({
    ...input,
    inputHash: childInputHash(input),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mitzo-session-service-'));
    dbPath = join(dir, 'events.db');
    events = new EventStore(dbPath);
    events.upsertSession({ sessionId: 'parent', mode: 'agent', accountBinding: binding });
    currentAuthority = authority();
    observed = [];
    runtime = {
      inspect: async (id) => {
        observed.push(`inspect:${id}`);
        return 'absent';
      },
      start: async (child) => {
        expect(events.getSession(child.conversationId)).not.toBeNull();
        observed.push(`start:${child.conversationId}`);
      },
      stop: async (id) => {
        observed.push(`stop:${id}`);
        return 'confirmed';
      },
    };
    service = new SessionService(dbPath, runtime, async () => currentAuthority);
    service.recordHostGrant(authority(), 'auth-session-1');
  });
  afterEach(() => {
    service.close();
    events.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('allocates one durable child before starting and reuses exact-key exact-input after restart', async () => {
    const child = service.createChild(request(), authority());
    expect(child.status).toBe('allocated');
    expect(events.getSession(child.conversationId)?.accountBinding).toEqual(binding);
    service.close();
    service = new SessionService(dbPath, runtime, async () => currentAuthority);
    expect(service.createChild(request(), authority())).toEqual(child);
    await service.reconcile(child.conversationId);
    expect(observed).toEqual([`inspect:${child.conversationId}`, `start:${child.conversationId}`]);
    expect(service.getChild(child.conversationId)?.status).toBe('running');
    expect(() =>
      service.createChild(rehash({ ...request(), prompt: 'changed' }), authority()),
    ).toThrow(/conflict/i);
  });

  it('reserves capacity atomically and refuses forged grant, parent, and sharing requests', () => {
    service.createChild(request(), authority());
    expect(() => service.createChild(request('task-2'), authority())).toThrow(/concurrent/i);
    expect(() =>
      service.createChild(rehash({ ...request('forged'), grantId: 'other' }), authority()),
    ).toThrow(/grant/i);
    expect(() =>
      service.createChild(
        rehash({ ...request('forged'), parentConversationId: 'other' }),
        authority(),
      ),
    ).toThrow(/parent/i);
    expect(() =>
      service.createChild(
        rehash({ ...request('shared'), isolation: 'symposium_shared' }),
        authority(),
      ),
    ).toThrow(/sharing/i);
  });

  it('recovers original worker and fences uncertain runtime state without a second start', async () => {
    const child = service.createChild(request(), authority());
    service.close();
    runtime.inspect = async () => 'running';
    service = new SessionService(dbPath, runtime, async () => currentAuthority);
    await service.reconcile(child.conversationId);
    expect(service.getChild(child.conversationId)?.status).toBe('running');
    expect(observed).toEqual([]);
    runtime.inspect = async () => 'unknown';
    await service.reconcile(child.conversationId);
    expect(service.getChild(child.conversationId)?.status).toBe('recovery_required');
    expect(observed).toEqual([]);
  });

  it('allows only one concurrent reconciliation to dispatch the same child', async () => {
    const child = service.createChild(request(), authority());
    let release!: () => void;
    runtime.start = async () => {
      observed.push('start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = service.reconcile(child.conversationId);
    await vi.waitFor(() => expect(observed).toContain('start'));
    const second = service.reconcile(child.conversationId);
    await Promise.resolve();
    expect(observed.filter((event) => event === 'start')).toHaveLength(1);
    release();
    await Promise.all([first, second]);
  });

  it('does not reclaim an expired start lease while the original start remains in flight', async () => {
    const child = service.createChild(request(), authority());
    let release!: () => void;
    runtime.start = async (_child, admitExecution) => {
      observed.push('start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      observed.push((await admitExecution()) ? 'execute' : 'fenced');
    };
    const first = service.reconcile(child.conversationId);
    await vi.waitFor(() => expect(observed).toContain('start'));
    const secondService = new SessionService(dbPath, runtime, async () => currentAuthority);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      await secondService.reconcile(child.conversationId);
      expect(observed.filter((event) => event === 'start')).toHaveLength(1);
    } finally {
      clock.mockRestore();
      secondService.close();
      release();
      await first;
    }
    expect(observed.filter((event) => event === `stop:${child.conversationId}`)).toHaveLength(2);
    expect(observed).toContain('fenced');
    expect(observed).not.toContain('execute');
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
  });

  it('treats equivalent authority object order as the same grant', async () => {
    const child = service.createChild(request(), authority());
    currentAuthority = {
      maxSpawnsPerMinute: 2,
      maxDepth: 2,
      maxConcurrent: 1,
      maxChildren: 2,
      allowedCapabilities: ['read'],
      allowedFiles: ['src/**'],
      planRevision: 'plan-1',
      taskNodeId: undefined,
      taskRootId: 'root',
      reasoningEffort: 'medium',
      accountBinding: { ...binding },
      grantRevision: 1,
      grantId: 'grant-a',
      parentActive: true,
      parentConversationId: 'parent',
    };
    await service.reconcile(child.conversationId);
    expect(service.getChild(child.conversationId)?.status).toBe('running');
  });

  it('persists an exact host grant and revokes its children without minting a new grant', async () => {
    const grant = service.recordHostGrant(authority(), 'auth-session-1');
    expect(service.recordHostGrant(authority(), 'auth-session-1')).toEqual(grant);
    expect(() =>
      service.recordHostGrant({ ...authority(), maxConcurrent: 2 }, 'auth-session-1'),
    ).toThrow(/conflict/i);
    const child = service.createChild(request(), authority());
    service.close();
    service = new SessionService(dbPath, runtime, async () => currentAuthority);
    expect(service.getHostGrant('grant-a', 1)?.actorSessionId).toBe('auth-session-1');
    await service.revokeHostGrant('grant-a', 1, 'auth-session-1');
    expect(service.getHostGrant('grant-a', 1)).toBeNull();
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
    expect(() => service.createChild(request('task-2'), authority())).toThrow(/grant|revoked/i);
  });

  it('fences revoked authority between allocation and dispatch and rejects changed binding or scope', async () => {
    const child = service.createChild(request(), authority());
    currentAuthority = null;
    await service.reconcile(child.conversationId);
    expect(observed).toEqual([]);
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
    expect(() =>
      service.createChild(
        rehash({
          ...request('other'),
          accountBinding: {
            ...binding,
            accountId: 'account-b',
          },
        }),
        authority(),
      ),
    ).toThrow(/binding/i);
    expect(() =>
      service.createChild(
        rehash({
          ...request('other'),
          scope: {
            files: ['secret/**'],
            capabilities: ['write'],
          },
        }),
        authority(),
      ),
    ).toThrow(/scope/i);
  });

  it('rechecks authority after runtime inspection before the start claim', async () => {
    const child = service.createChild(request(), authority());
    let release!: (value: 'absent') => void;
    runtime.inspect = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const reconciling = service.reconcile(child.conversationId);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    currentAuthority = null;
    release('absent');
    await reconciling;
    expect(observed.filter((event) => event.startsWith('start:'))).toEqual([]);
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
  });

  it('stops a claimed start whose authority is revoked before runtime acceptance', async () => {
    const child = service.createChild(request(), authority());
    let release!: () => void;
    runtime.start = async () => {
      observed.push('start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const reconciling = service.reconcile(child.conversationId);
    await vi.waitFor(() => expect(observed).toContain('start'));
    currentAuthority = null;
    release();
    await reconciling;
    expect(observed).toContain(`stop:${child.conversationId}`);
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
  });

  it('does not let a late observation overwrite cancellation', async () => {
    const child = service.createChild(request(), authority());
    let release!: (value: 'running') => void;
    runtime.inspect = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const reconciling = service.reconcile(child.conversationId);
    await Promise.resolve();
    await service.cancelChild(child.conversationId, 'parent');
    release('running');
    await reconciling;
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
  });

  it('cleans up an attachment that completes after cancellation', async () => {
    const child = service.createChild(request(), authority());
    let release!: () => void;
    runtime.start = async () => {
      observed.push('start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const starting = service.reconcile(child.conversationId);
    await vi.waitFor(() => expect(observed).toContain('start'));
    await service.cancelChild(child.conversationId, 'parent');
    release();
    await starting;
    expect(observed.filter((event) => event.startsWith('stop:'))).toHaveLength(2);
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
  });

  it('persists revocation before stop, prevents start, and retains parent-visible child result', async () => {
    const child = service.createChild(request(), authority());
    await service.cancelChild(child.conversationId, 'parent');
    expect(service.getChild(child.conversationId)?.status).toBe('cancelled');
    expect(observed).toEqual([]);
    await service.reconcile(child.conversationId);
    expect(observed).toEqual([]);
    expect(() =>
      service.submitResult(child.conversationId, child.conversationId, child.generation, 'late'),
    ).toThrow(/cancel/i);

    const next = service.createChild(request('task-2'), authority());
    await service.reconcile(next.conversationId);
    service.submitResult(next.conversationId, next.conversationId, next.generation, 'done');
    expect(service.readMailbox(next.conversationId, 'parent')).toMatchObject([
      { type: 'result', payload: 'done' },
    ]);
    expect(() => service.readMailbox(next.conversationId, 'sibling')).toThrow(/authority/i);
  });
});
