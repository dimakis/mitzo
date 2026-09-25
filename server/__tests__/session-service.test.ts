import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { SessionService, type ChildRuntime } from '../session-service.js';

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

  const authority = () => ({
    parentConversationId: 'parent',
    allowedGrantIds: ['grant-a'],
    maxChildren: 2,
    maxConcurrent: 1,
    maxDepth: 2,
    maxSpawnsPerMinute: 2,
  });
  const request = (key = 'task-1') => ({
    parentConversationId: 'parent',
    idempotencyKey: key,
    inputHash: 'a'.repeat(64),
    prompt: 'Do the bounded task',
    taskRootId: 'root',
    taskNodeId: key,
    grantId: 'grant-a',
    accountBinding: binding,
    isolation: 'independent' as const,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mitzo-session-service-'));
    dbPath = join(dir, 'events.db');
    events = new EventStore(dbPath);
    events.upsertSession({ sessionId: 'parent', mode: 'agent', accountBinding: binding });
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
    service = new SessionService(dbPath, runtime);
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
    service = new SessionService(dbPath, runtime);
    expect(service.createChild(request(), authority())).toEqual(child);
    await service.reconcile(child.conversationId);
    expect(observed).toEqual([`inspect:${child.conversationId}`, `start:${child.conversationId}`]);
    expect(service.getChild(child.conversationId)?.status).toBe('running');
    expect(() => service.createChild({ ...request(), prompt: 'changed' }, authority())).toThrow(
      /conflict/i,
    );
  });

  it('reserves capacity atomically and refuses forged grant, parent, and sharing requests', () => {
    service.createChild(request(), authority());
    expect(() => service.createChild(request('task-2'), authority())).toThrow(/concurrent/i);
    expect(() =>
      service.createChild({ ...request('forged'), grantId: 'other' }, authority()),
    ).toThrow(/grant/i);
    expect(() =>
      service.createChild({ ...request('forged'), parentConversationId: 'other' }, authority()),
    ).toThrow(/parent/i);
    expect(() =>
      service.createChild({ ...request('shared'), isolation: 'symposium_shared' }, authority()),
    ).toThrow(/sharing/i);
  });

  it('recovers original worker and fences uncertain runtime state without a second start', async () => {
    const child = service.createChild(request(), authority());
    service.close();
    runtime.inspect = async () => 'running';
    service = new SessionService(dbPath, runtime);
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
    await Promise.resolve();
    const second = service.reconcile(child.conversationId);
    await Promise.resolve();
    expect(observed.filter((event) => event === 'start')).toHaveLength(1);
    release();
    await Promise.all([first, second]);
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
    await Promise.resolve();
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
    expect(() => service.submitResult(child.conversationId, child.conversationId, 'late')).toThrow(
      /cancel/i,
    );

    const next = service.createChild(request('task-2'), authority());
    await service.reconcile(next.conversationId);
    service.submitResult(next.conversationId, next.conversationId, 'done');
    expect(service.readMailbox(next.conversationId, 'parent')).toMatchObject([
      { type: 'result', payload: 'done' },
    ]);
    expect(() => service.readMailbox(next.conversationId, 'sibling')).toThrow(/authority/i);
  });
});
