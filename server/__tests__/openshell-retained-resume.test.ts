import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellRuntimeManager, sandboxNameForConversation } from '../openshell-runtime.js';
import {
  initializeOpenShellLifecycle,
  registerOpenShellLifecycle,
  assertOrdinaryOpenShellPhysicalOwner,
  resumeOrdinaryOpenShellPhysicalOwner,
} from '../openshell-lifecycle-controller.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const config = {
  cli: 'openshell',
  image: 'offline-image',
  policy: '/offline/policy',
  seed: '/offline/seed',
  workspace: 'default',
  gateway: 'local',
  gatewayInsecure: false,
  workdir: '/sandbox/task',
  serviceProviders: [],
  grantableServiceProviders: [],
  createDetached: true,
  sandboxIdLength: 13,
  webSearch: 'disabled' as const,
};
const route = { kind: 'api' as const, provider: 'offline', model: 'fixture' };
const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai',
  model: 'fixture',
  profileRevision: '1',
};
const conversationId = 'offline-conversation';
const sandboxName = sandboxNameForConversation(conversationId);
const runtime = {
  sandboxName,
  sandboxId: 'original-id',
  workdir: config.workdir,
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  cli: config.cli,
  gateway: config.gateway,
  workspace: config.workspace,
  gatewayInsecure: false,
};
const artifact = { runtime, route };

it.each(['Stopped', 'Ready'])(
  'recovers the original %s sandbox without creating or redundantly starting it',
  async (initial) => {
    let phase = initial;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('start')) {
        phase = 'Ready';
        return '{}';
      }
      return JSON.stringify({
        id: runtime.sandboxId,
        name: sandboxName,
        phase,
        labels: {
          'mitzo.conversation': createHash('sha256')
            .update(conversationId)
            .digest('hex')
            .slice(0, 63),
          'mitzo.account_provider': route.provider,
        },
      });
    });
    const current = vi.fn();
    await new OpenShellRuntimeManager({ ...config, account: route }, run).start(
      conversationId,
      runtime.sandboxId,
      new AbortController().signal,
      current,
    );
    expect(run.mock.calls.filter(([args]) => args.includes('start'))).toHaveLength(
      initial === 'Stopped' ? 1 : 0,
    );
    expect(run.mock.calls.flat(2)).not.toContain('create');
    expect(current).toHaveBeenCalled();
  },
);

it.each(['identity', 'name', 'revocation', 'replacement', 'provider'])(
  'preserves the stopped sandbox when %s prevents qualified recovery',
  async (failure) => {
    let phase = 'Stopped';
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes('start')) {
        phase = 'Ready';
        return '{}';
      }
      return JSON.stringify({
        id:
          failure === 'identity' || (failure === 'replacement' && phase === 'Ready')
            ? 'foreign-id'
            : runtime.sandboxId,
        name: failure === 'name' ? 'foreign-name' : sandboxName,
        phase,
        labels: {
          'mitzo.conversation': createHash('sha256')
            .update(conversationId)
            .digest('hex')
            .slice(0, 63),
          'mitzo.account_provider':
            failure === 'provider' && phase === 'Ready' ? 'foreign' : route.provider,
        },
      });
    });
    await expect(
      new OpenShellRuntimeManager({ ...config, account: route }, run).start(
        conversationId,
        runtime.sandboxId,
        new AbortController().signal,
        () => {
          if (failure === 'revocation') throw Error('revoked');
        },
      ),
    ).rejects.toThrow(
      failure === 'revocation'
        ? 'revoked'
        : /identity changed|target name changed|provider binding/,
    );
    if (!['replacement', 'provider'].includes(failure))
      expect(run.mock.calls.flat(2)).not.toContain('start');
    expect(run.mock.calls.flat(2)).not.toContain('create');
  },
);

it.each([
  'success',
  'revocation',
  'start failure',
  'generation changed',
  'deleted',
  'failed',
  'foreign binding',
])('preserves lifecycle custody through qualified restart: %s', async (outcome) => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-retained-resume-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'offline: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const lifecycle = initializeOpenShellLifecycle(
    { ...config, policy },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  try {
    registerOpenShellLifecycle(
      conversationId,
      runtime,
      binding,
      route,
      'original-thread',
      'client',
    );
    const original = lifecycle.store.get(conversationId)!;
    lifecycle.store.upsert({
      ...original,
      phase: outcome === 'deleted' || outcome === 'failed' ? outcome : 'stopped',
      generation: original.generation + 1,
      stoppedAt: Date.now(),
      stoppedResourceVersion: 'stopped-revision',
    });
    let revoked = false;
    const start = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'start')
      .mockImplementation(async () => {
        if (outcome === 'start failure') throw Error('offline start failed');
        if (outcome === 'revocation') revoked = true;
        if (outcome === 'generation changed') {
          const changed = lifecycle.store.get(conversationId)!;
          lifecycle.store.upsert({ ...changed, generation: changed.generation + 1 });
        }
      });
    const current = vi.fn(() => {
      if (revoked) throw Error('revoked');
    });
    expect(() => assertOrdinaryOpenShellPhysicalOwner(conversationId, artifact, binding)).toThrow();
    const resume = resumeOrdinaryOpenShellPhysicalOwner(
      conversationId,
      artifact,
      outcome === 'foreign binding' ? { ...binding, accountId: 'foreign' } : binding,
      new AbortController().signal,
      current,
    );
    if (outcome !== 'success') {
      await expect(resume).rejects.toThrow();
      expect(lifecycle.store.get(conversationId)).toMatchObject({
        phase: outcome === 'deleted' || outcome === 'failed' ? outcome : 'stopped',
        physicalSandboxId: runtime.sandboxId,
        stoppedResourceVersion: 'stopped-revision',
        identity: { threadId: 'original-thread' },
      });
      if (['deleted', 'failed', 'foreign binding'].includes(outcome))
        expect(start).not.toHaveBeenCalled();
      return;
    }
    await resume;
    expect(start).toHaveBeenCalledWith(
      conversationId,
      runtime.sandboxId,
      expect.anything(),
      expect.any(Function),
    );
    expect(() =>
      assertOrdinaryOpenShellPhysicalOwner(conversationId, artifact, binding),
    ).not.toThrow();
    expect(lifecycle.store.get(conversationId)).toMatchObject({
      phase: 'retained',
      physicalSandboxId: runtime.sandboxId,
      identity: { threadId: 'original-thread' },
      stoppedAt: null,
      stoppedResourceVersion: null,
      idleSince: null,
    });
  } finally {
    lifecycle.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
