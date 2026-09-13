import { basename, dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import {
  checkpointDirectoryForConversation,
  initializeOpenShellLifecycle,
  registerOpenShellLifecycle,
  registerOpenShellLifecycleProvisional,
} from '../openshell-lifecycle-controller.js';

it('hashes arbitrary conversation IDs before creating checkpoint directories', () => {
  const base = '/private/mitzo';
  const ids = ['../escape', '/absolute/path', '会話/../../escape', 'stable id'];
  const paths = ids.map((id) => checkpointDirectoryForConversation(base, id, 7));
  expect(checkpointDirectoryForConversation(base, ids[0]!, 7)).toBe(paths[0]);
  for (const path of paths) {
    expect(dirname(dirname(path))).toBe(`${base}/openshell-checkpoints`);
    expect(basename(dirname(path))).toMatch(/^[a-f0-9]{64}$/);
    expect(basename(path)).toBe('7');
  }
  expect(paths[0]).not.toBe(paths[1]);
});

it('does not read the checkpoint policy when lifecycle is disabled', () => {
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '');
  try {
    expect(
      initializeOpenShellLifecycle(
        {
          cli: 'openshell',
          image: 'mitzo-runtime:1',
          policy: '/unavailable/lifecycle-policy.yaml',
          seed: '/seed/mgmt',
          serviceProviders: [],
          grantableServiceProviders: [],
          workspace: 'default',
          gateway: 'openshell',
          gatewayInsecure: false,
          createDetached: true,
          sandboxIdLength: 13,
          workdir: '/sandbox/workspaces/mgmt',
          webSearch: 'disabled',
        },
        {} as Parameters<typeof initializeOpenShellLifecycle>[1],
      ),
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('keeps a newly ensured sandbox durably fenced until its provider thread is ready', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-lifecycle-controller-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', directory);
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  try {
    const lifecycle = initializeOpenShellLifecycle(
      {
        cli: 'openshell',
        image: 'mitzo-runtime:1',
        policy,
        seed: '/seed/mgmt',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      {
        registry: { findBySessionId: () => undefined, entries: function* () {} },
        eventStore: { getSession: () => ({}) },
        taskStore: { getTree: () => [] },
        queue: () => ({ queued: 0, running: 0, recovery: false }),
      },
    )!;
    const runtime = {
      sandboxName: 'mitzo-sandbox',
      sandboxId: 'physical-id',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      gateway: 'openshell',
      workspace: 'default',
      gatewayInsecure: false,
    };
    const account = { kind: 'api' as const, provider: 'openai-work', model: 'model' };
    const binding = {
      accountId: 'account',
      accountLabel: 'Account',
      provider: 'openai',
      model: 'model',
      profileRevision: '1',
    };
    registerOpenShellLifecycleProvisional('conversation', runtime, account, 'client');
    expect(lifecycle.store.get('conversation')).toMatchObject({
      phase: 'retained',
      physicalSandboxId: 'physical-id',
      identity: null,
    });
    registerOpenShellLifecycle('conversation', runtime, binding, account, 'thread', 'client');
    expect(lifecycle.store.get('conversation')).toMatchObject({
      physicalSandboxId: 'physical-id',
      identity: expect.objectContaining({ threadId: 'thread' }),
    });
    lifecycle.store.close();
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
