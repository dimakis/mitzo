import { expect, it, vi } from 'vitest';
import { readLegacySandboxDeletionRecord } from '../legacy-sandbox-deletion.js';
import type { CodexConversationStore } from '../codex-conversation-store.js';
import type { SessionMeta } from '../event-store.js';

function fixture() {
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
  const artifact = {
    runtime,
    route: { kind: 'api' as const, provider: 'saved-provider', model: 'offline' },
  };
  const owner = {
    conversationId: 'c',
    physicalId: 'physical',
    sandboxName: 'legacy',
    workspace: 'default',
    gateway: 'gateway',
    gatewayEndpoint: null,
    accountId: 'work',
    ownerKind: 'ordinary',
    relation: 'runtime',
  };
  const meta = {
    sessionType: 'chat',
    symposiumConfig: null,
    accountBinding: binding,
    updatedAt: 100,
  } as SessionMeta;
  const native = {
    read: vi.fn(() => ({ threadId: 'thread', cwd: runtime.workdir, recovery: false })),
    readArtifactRuntime: vi.fn(() => artifact),
    readRuntimeMigration: vi.fn(() => null),
    listSandboxOwnership: vi.fn(() => [owner]),
  };
  const config = {
    workspace: 'default',
    gateway: 'gateway',
    gatewayInsecure: false,
    workdir: runtime.workdir,
    image: 'current-capture-image',
  };
  const events = {
    getSession: () => meta,
    listRetainedSymposiumSandboxOwners: vi.fn((): never[] => []),
  };
  const read = () =>
    readLegacySandboxDeletionRecord(
      'c',
      events,
      native as unknown as CodexConversationStore,
      config,
      'current-capture-policy',
    );
  return { native, artifact, owner, meta, config, events, read };
}

it('uses the exact saved legacy runtime and thread without inventing historical custody', () => {
  const f = fixture();
  expect(f.read()).toMatchObject({
    conversationId: 'c',
    physicalSandboxId: 'physical',
    sandboxName: 'legacy',
    accountProvider: 'saved-provider',
    phase: 'retained',
    checkpoint: null,
    idleSince: null,
    retentionConsent: false,
    lastActivityAt: 100,
    identity: {
      threadId: 'thread',
      accountId: 'work',
      profileRevision: 'r1',
      image: 'current-capture-image',
      policyDigest: 'current-capture-policy',
    },
  });
  expect(f.native.read).toHaveBeenCalledWith('c', f.meta.accountBinding);
});

it.each([
  'symposium',
  'seat',
  'migration',
  'conflict',
  'owner',
  'provider',
  'model',
  'gateway',
  'endpoint',
  'workspace',
  'workdir',
  'recovery',
  'thread',
  'binding',
])('refuses legacy deletion with %s uncertainty', (change) => {
  const f = fixture();
  if (change === 'symposium') f.meta.sessionType = 'symposium';
  if (change === 'seat') f.events.listRetainedSymposiumSandboxOwners.mockReturnValue([{} as never]);
  if (change === 'migration') f.owner.relation = 'migration_source';
  if (change === 'conflict')
    f.native.listSandboxOwnership.mockReturnValue([
      f.owner,
      { ...f.owner, conversationId: 'other' },
    ]);
  if (change === 'owner') f.owner.ownerKind = 'symposium';
  if (change === 'provider') f.artifact.route.kind = 'chatgpt-subscription-native' as 'api';
  if (change === 'model') f.artifact.route.model = 'other';
  if (change === 'gateway') f.config.gateway = 'other';
  if (change === 'endpoint')
    Object.assign(f.artifact.runtime, { gatewayEndpoint: 'https://other' });
  if (change === 'workspace') f.config.workspace = 'other';
  if (change === 'workdir') f.config.workdir = '/other';
  if (change === 'recovery')
    f.native.read.mockReturnValue({
      threadId: 'thread',
      cwd: f.artifact.runtime.workdir,
      recovery: true,
    });
  if (change === 'thread')
    f.native.read.mockReturnValue({
      threadId: '',
      cwd: f.artifact.runtime.workdir,
      recovery: false,
    });
  if (change === 'binding')
    f.native.read.mockImplementation(() => {
      throw Error('binding changed');
    });
  expect(f.read).toThrow();
});
