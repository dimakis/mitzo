import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readLegacySandboxDeletionRecord } from '../legacy-sandbox-deletion.js';
import { createOpenShellLifecycleProductionAdapter } from '../openshell-lifecycle-production.js';
import { OpenShellLifecycleService } from '../openshell-lifecycle-service.js';
import { OpenShellLifecycleStore, openShellLifecyclePolicy } from '../openshell-lifecycle.js';
import { TaskStore, type TaskStatus } from '../task-store.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-task-preservation-'));
  const taskPath = join(root, 'tasks.db');
  let tasks = new TaskStore(taskPath);
  const lifecycle = new OpenShellLifecycleStore(join(root, 'lifecycle.db'));
  const binding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    model: 'offline',
    profileRevision: 'r1',
  };
  const runtime = {
    sandboxName: 'legacy',
    sandboxId: 'physical',
    workdir: '/sandbox/workspaces/mgmt',
    cli: 'openshell',
    gateway: 'gateway',
    workspace: 'default',
    gatewayInsecure: false,
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  };
  const route = { kind: 'api' as const, provider: 'saved-provider', model: 'offline' };
  const events = {
    getSession: () => ({ accountBinding: binding, updatedAt: 100, sessionType: 'chat' }),
    listRetainedSymposiumSandboxOwners: () => [],
  };
  const native = {
    read: () => ({ threadId: 'thread', cwd: runtime.workdir }),
    readArtifactRuntime: () => ({ runtime, route }),
    readRuntimeMigration: () => null,
    listSandboxOwnership: () => [
      {
        conversationId: 'c',
        physicalId: 'physical',
        sandboxName: 'legacy',
        workspace: 'default',
        gateway: 'gateway',
        gatewayEndpoint: null,
        accountId: 'work',
        ownerKind: 'ordinary' as const,
        relation: 'runtime' as const,
      },
    ],
  };
  const read = () =>
    readLegacySandboxDeletionRecord(
      'c',
      events,
      native,
      {
        ...runtime,
        image: 'capture-image',
      },
      'capture-policy',
    );
  const clients = new Map<string, { sessionId: string }>();
  const checkpoint = vi.fn(async () => null);
  const stop = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const adapter = createOpenShellLifecycleProductionAdapter({
    registry: { findBySessionId: () => null, entries: () => clients.entries() },
    eventStore: events,
    taskStore: {
      getTree: () => tasks.getTree(),
      getTelosExecutionBinding: (id) => tasks.getTelosExecutionBinding(id),
    },
    queue: () => ({ queued: 0, running: 0, recovery: false }),
    inspect: async () => ({ id: 'physical', phase: 'Ready', resourceVersion: 'ready-v' }),
    checkpoint,
    stop,
    delete: remove,
    verifyCheckpoint: async () => true,
  });
  const service = new OpenShellLifecycleService(
    lifecycle,
    openShellLifecyclePolicy({ MITZO_OPENSHELL_LIFECYCLE_ENABLED: '1' }),
    adapter,
  );
  const persistTask = (status: TaskStatus, delegated = false) => {
    const task = delegated
      ? tasks.createOrRecoverTelosExecutionTask(
          { title: 'Retained task' },
          {
            attemptId: 'attempt',
            childItemId: 'slice',
            leadConversationId: 'lead',
            workerConversationId: 'other-conversation',
            contextSnapshotId: 'context',
            contextHash: 'a'.repeat(64),
          },
        )
      : tasks.create({ title: 'Retained task' });
    tasks.setSessionId(task.id, 'disconnected-client');
    tasks.update(task.id, { status });
    tasks.close();
    tasks = new TaskStore(taskPath);
    return tasks.get(task.id)!;
  };
  return {
    read,
    lifecycle,
    service,
    clients,
    persistTask,
    checkpoint,
    stop,
    remove,
    tasks: () => tasks,
    close: () => {
      tasks.close();
      lifecycle.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each(['blocked', 'pending_review'] as const)(
  'preserves legacy resources for a persisted disconnected %s Task Board owner at preview',
  async (status) => {
    const f = fixture();
    try {
      const before = f.persistTask(status);
      expect(f.read().ownerClientId).toBeNull();
      expect(f.tasks().getOrphaned(new Set())).toEqual([]);
      const preview = await f.service.previewLegacyDeletion(f.read, AbortSignal.timeout(1000));
      expect(preview.action).toBe('none');
      expect(preview.blockers).toEqual(
        expect.arrayContaining(['task_board', 'ambiguous_ownership']),
      );
      expect(f.lifecycle.list()).toEqual([]);
      expect(f.tasks().get(before.id)).toEqual(before);
      expect(f.checkpoint).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  },
);

it.each(['blocked', 'pending_review'] as const)(
  'rechecks a newly persisted disconnected %s owner at confirmation before enrollment or checkpoint',
  async (status) => {
    const f = fixture();
    try {
      const preview = await f.service.previewLegacyDeletion(f.read, AbortSignal.timeout(1000));
      expect(preview.action).toBe('stop_and_delete');
      const before = f.persistTask(status);
      await expect(
        f.service.confirm(preview.token, AbortSignal.timeout(1000), 'c'),
      ).rejects.toThrow('preservation check failed');
      expect(f.lifecycle.list()).toEqual([]);
      expect(f.tasks().get(before.id)).toEqual(before);
      expect(f.checkpoint).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  },
);

it.each(['done', 'skipped', 'failed', 'unrelated-live', 'unrelated-delegated'] as const)(
  'keeps legacy deletion review available with %s Task Board ownership evidence',
  async (control) => {
    const f = fixture();
    try {
      const before = f.persistTask(
        control.startsWith('unrelated') ? 'blocked' : (control as TaskStatus),
        control === 'unrelated-delegated',
      );
      if (control === 'unrelated-live')
        f.clients.set('disconnected-client', { sessionId: 'other-conversation' });
      const preview = await f.service.previewLegacyDeletion(f.read, AbortSignal.timeout(1000));
      expect(preview.action).toBe('stop_and_delete');
      expect(preview.blockers).toEqual([]);
      expect(f.tasks().get(before.id)).toEqual(before);
      expect(f.lifecycle.list()).toEqual([]);
      expect(f.checkpoint).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  },
);
