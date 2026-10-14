import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';

const binding = {
  version: 2 as const,
  account: { accountId: 'personal', provider: 'openai-codex' as const, profileRevision: 'profile' },
  harness: { implementation: 'codex' as const },
  execution: { location: 'openshell' as const, targetId: 'mac', targetRevision: 'target' },
};
const selection = {
  version: 1 as const,
  agent: { profileId: 'agent', revision: 1 },
  context: { source: 'none' as const, revision: null },
  permission: { mode: 'agent' as const, revision: 0 },
  model: 'first-model',
  thinking: 'low',
};
const meta = {
  sessionId: 'conversation',
  repositoryWorkspaceId: 'workspace',
  cwd: '/sandbox/workspaces/checkout',
  accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'first-model' },
  mode: 'agent' as const,
  selectedModel: 'first-model',
  reasoningEffort: 'low',
};
const command = (id: string, model = 'first-model') => ({
  clientMsgId: id,
  requestFingerprint: `fingerprint-${id}-${model}`,
  selection: { ...selection, model },
  payload: { text: `message ${id}` },
});
const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stores.forEach((s) => s.close());
  stores.length = 0;
  roots.forEach((p) => rmSync(p, { recursive: true, force: true }));
  roots.length = 0;
});
function fixture(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  store.admitOrdinaryOpenShellCommand(meta, binding, command('first'));
  store.claimOrdinaryOpenShellCommandDispatch('first');
  store.completeOrdinaryOpenShellCommand('first');
  return store;
}
const futureMeta = {
  ...meta,
  accountBinding: { ...meta.accountBinding, model: 'next-model' },
  selectedModel: 'next-model',
};

describe('bound OpenShell subsequent command storage', () => {
  it('freezes later settings without rewriting account, session, first or queued commands', () => {
    const store = fixture();
    const original = store.getSession('conversation');
    const queued = store.admitOrdinaryOpenShellContinuation(
      futureMeta,
      binding,
      command('queued', 'next-model'),
    );
    expect(queued.admission.selection.model).toBe('next-model');
    expect(store.getSession('conversation')).toEqual(original);
    expect(store.getOrdinaryOpenShellCommandAdmission('first')?.selection.model).toBe(
      'first-model',
    );
    expect(
      store.admitOrdinaryOpenShellContinuation(meta, binding, command('third')).admission.selection
        .model,
    ).toBe('first-model');
    expect(store.getOrdinaryOpenShellCommandAdmission('queued')).toEqual(queued.admission);
  });
  it('retains exact retries across reopen and prevents two stores claiming effects', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-continuation-'));
    roots.push(root);
    const path = join(root, 'events.db');
    const first = fixture(path);
    first.admitOrdinaryOpenShellContinuation(futureMeta, binding, command('next', 'next-model'));
    const second = new EventStore(path);
    stores.push(second);
    expect(
      second.admitOrdinaryOpenShellContinuation(futureMeta, binding, command('next', 'next-model'))
        .duplicate,
    ).toBe(true);
    expect(first.claimOrdinaryOpenShellCommandDispatch('next')).toBe(true);
    expect(second.claimOrdinaryOpenShellCommandDispatch('next')).toBe(false);
    second.completeOrdinaryOpenShellCommand('next');
    expect(first.getOrdinaryOpenShellCommandAdmission('next')?.state).toBe('consumed');
  });
  it.each(['target', 'account', 'workspace', 'agent', 'context', 'permission', 'payload'])(
    'rejects %s drift atomically',
    (kind) => {
      const store = fixture();
      const runtime = structuredClone(binding);
      const session = structuredClone(futureMeta);
      const input = command('next', 'next-model');
      if (kind === 'target') runtime.execution.targetRevision = 'other';
      if (kind === 'account') session.accountBinding.profileRevision = 'other';
      if (kind === 'workspace') session.cwd = '/sandbox/workspaces/other';
      if (kind === 'agent') input.selection.agent.revision++;
      if (kind === 'context')
        input.selection.context = { source: 'workspace', revision: 'recipe' } as never;
      if (kind === 'permission') input.selection.permission.revision++;
      if (kind === 'payload') {
        store.admitOrdinaryOpenShellContinuation(session, runtime, input);
        input.payload.text = 'replaced';
      }
      expect(() => store.admitOrdinaryOpenShellContinuation(session, runtime, input)).toThrow();
      if (kind !== 'payload') expect(store.getSendCommand('next')).toBeUndefined();
      expect(store.getSession('conversation')?.cwd).toBe(meta.cwd);
    },
  );
  it('refuses legacy and dormant enrollment and an uncertain prior command', () => {
    const store = new EventStore(':memory:');
    stores.push(store);
    store.createSessionWithRuntimeBinding(meta, binding);
    expect(() =>
      store.admitOrdinaryOpenShellContinuation(meta, binding, command('next')),
    ).toThrow();
    const bound = fixture();
    bound.admitOrdinaryOpenShellContinuation(meta, binding, command('pending'));
    bound.claimOrdinaryOpenShellCommandDispatch('pending');
    expect(() =>
      bound.admitOrdinaryOpenShellContinuation(meta, binding, command('next')),
    ).toThrow();
    expect(bound.getSendCommand('next')).toBeUndefined();
    expect(bound.getOrdinaryOpenShellCommandAdmission('pending')?.state).toBe('uncertain');
  });
  it('preserves the first-command refusal for callers without continuation authority', () => {
    const store = fixture();
    expect(() => store.admitOrdinaryOpenShellCommand(meta, binding, command('next'))).toThrow(
      'new session',
    );
  });
});

it('keeps Local receipt consumers separate and preserves OpenShell guarded restart evidence', () => {
  const store = fixture();
  expect(store.getOrdinaryLocalCommandAdmission('first')).toBeUndefined();
  store.recoverPendingSendCommands();
  expect(store.getOrdinaryOpenShellCommandAdmission('first')?.state).toBe('consumed');
});
