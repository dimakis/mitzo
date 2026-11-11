import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import {
  assertStaleOrdinaryAdmissionRecovery,
  staleOrdinaryAdmissionCases,
} from './fixtures/ordinary-admission-recovery.js';
const binding = {
  version: 2,
  account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'p1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: 't1' },
} as const;
const meta = {
  sessionId: 's1',
  accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'fixture' },
  repositoryWorkspaceId: 'w1',
  cwd: '/task',
};
const input = {
  clientMsgId: 'c1',
  requestFingerprint: 'fp1',
  payload: { prompt: 'hello' },
  selection: {
    version: 1,
    agent: { profileId: 'a1', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'ask', revision: 0 },
    model: 'fixture',
    thinking: null,
  },
} as const;
const stores: EventStore[] = [];
function open(path = ':memory:') {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
});
describe('ordinary local durable command admission', () => {
  const transition = {
    sessionId: 's1',
    operationId: 'handover',
    fingerprint: 'a'.repeat(64),
    expectedEpoch: 0,
  };
  it('fences fresh command, startup and execution admission without changing unrelated chats', () => {
    const store = open();
    store.contextTransitions.begin(transition);
    expect(() => store.admitOrdinaryLocalCommand(meta, binding, input)).toThrow(/transition/i);
    expect(store.getSession('s1')).toBeNull();
    expect(store.getSendCommand('c1')).toBeUndefined();
    expect(() => store.reserveOrdinaryStartup(['s1'])).toThrow(/transition/i);
    store.upsertSession({ sessionId: 's1' });
    expect(() => store.beginExecution('s1')).toThrow(/transition/i);
    expect(() =>
      store.admitOrdinaryLocalCommand(
        { ...meta, sessionId: 'other', repositoryWorkspaceId: 'other-workspace' },
        binding,
        { ...input, clientMsgId: 'other', requestFingerprint: 'other' },
      ),
    ).not.toThrow();
  });
  it('rejects preparation captured before a hold even after release and admits newly captured context', async () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    store.claimOrdinaryLocalCommandDispatch('c1');
    store.completeOrdinaryLocalCommand('c1');
    const original = store.getOrdinaryLocalCommandAdmission('c1');
    const captured = store.contextTransitions.capture('s1');
    let continuePreparation!: () => void;
    const paused = new Promise<void>((resolve) => {
      continuePreparation = resolve;
    });
    const next = { ...input, clientMsgId: 'next', requestFingerprint: 'next' };
    const pending = store.withOrdinaryContextAdmission('s1', captured, async () => {
      await paused;
      return store.admitOrdinaryLocalContinuation(meta, binding, next);
    });
    store.contextTransitions.begin(transition);
    store.contextTransitions.release(transition, 'aborted', () => undefined);
    continuePreparation();
    await expect(pending).rejects.toThrow(/stale/i);
    expect(store.getSendCommand('next')).toBeUndefined();
    const current = store.contextTransitions.capture('s1');
    store.withOrdinaryContextAdmission('s1', current, () =>
      store.admitOrdinaryLocalContinuation(meta, binding, next),
    );
    expect(store.contextTransitions.readCommand('next')?.epoch).toBe(1);
    expect(store.claimOrdinaryLocalCommandDispatch('next')).toBe(true);
    expect(() => store.beginExecution('s1', 'next-execution', 'next', 'next')).toThrow(/stale/i);
    expect(() =>
      store.withOrdinaryContextAdmission('s1', current, () =>
        store.beginExecution('s1', 'old-execution', 'c1', 'fp1'),
      ),
    ).toThrow(/stale/i);
    const execution = store.withOrdinaryContextAdmission('s1', current, () =>
      store.beginExecution('s1', 'next-execution', 'next', 'next'),
    );
    expect(() => store.transitionExecution(execution.token, 'TERMINAL', 'completed')).not.toThrow();
    expect(store.getOrdinaryLocalCommandAdmission('c1')).toEqual(original);
  });
  it('refuses stale reserved dispatch and preserves its receipt after a transition', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    const original = store.getOrdinaryLocalCommandAdmission('c1');
    store.contextTransitions.begin(transition);
    expect(() => store.claimOrdinaryLocalCommandDispatch('c1')).toThrow(/transition/i);
    store.contextTransitions.release(transition, 'committed', () => undefined);
    expect(() => store.claimOrdinaryLocalCommandDispatch('c1')).toThrow(/stale/i);
    expect(store.getOrdinaryLocalCommandAdmission('c1')).toEqual(original);
    expect(store.contextTransitions.readCommand('c1')?.epoch).toBe(0);
  });
  it('keeps already-running terminal receipts writable while new context admission is fenced', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    store.claimOrdinaryLocalCommandDispatch('c1');
    const execution = store.beginExecution('s1', 'running', 'c1', 'fp1');
    store.contextTransitions.begin(transition);
    expect(() => store.completeOrdinaryLocalCommand('c1')).not.toThrow();
    expect(() => store.transitionExecution(execution.token, 'TERMINAL', 'completed')).not.toThrow();
    expect(store.getExecutionTerminalReason(execution.token)).toBe('completed');
    expect(() => store.insertSendCommand('blocked', 's1', { prompt: 'new input' })).toThrow(
      /transition/i,
    );
  });
  it('rolls back command and epoch together when outer admission fails', () => {
    const store = open();
    const retain = store.contextTransitions.retainCommand.bind(store.contextTransitions);
    vi.spyOn(store.contextTransitions, 'retainCommand').mockImplementation((...args) => {
      retain(...args);
      throw Error('Retained stamp rollback');
    });
    expect(() => store.admitOrdinaryLocalCommand(meta, binding, input)).toThrow(
      'Retained stamp rollback',
    );
    expect(store.contextTransitions.readCommand('c1')).toBeUndefined();
    expect(store.getSendCommand('c1')).toBeUndefined();
    expect(store.getSession('s1')).toBeNull();
  });
  it('atomically freezes settings and exact retries without allocating execution', () => {
    const store = open();
    expect(store.admitOrdinaryLocalCommand(meta, binding, input).duplicate).toBe(false);
    expect(store.admitOrdinaryLocalCommand(meta, binding, input).duplicate).toBe(true);
    expect(store.getOrdinaryLocalCommandAdmission('c1')?.selection).toEqual(input.selection);
    expect(store.getExecutionAdmission('s1', 'c1')).toBeUndefined();
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, model: 'different' },
      }),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, { ...input, payload: { prompt: 'changed' } }),
    ).toThrow();
  });
  it('rolls back binding and global identity when receipt insertion fails', () => {
    const store = open();
    vi.spyOn(store, 'insertSendCommand').mockImplementation(() => {
      throw new Error('injected');
    });
    expect(() => store.admitOrdinaryLocalCommand(meta, binding, input)).toThrow('injected');
    expect(store.getSession('s1')).toBeNull();
    expect(() => store.claimClientCommand('c1', 'different')).not.toThrow();
  });
  it('retains non-replay uncertainty across competing stores and cold reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-admission-'));
    const path = join(dir, 'db');
    try {
      const first = open(path),
        second = open(path);
      first.admitOrdinaryLocalCommand(meta, binding, input);
      expect(first.deploymentStartupPending()).toBe(true);
      expect(second.admitOrdinaryLocalCommand(meta, binding, input).duplicate).toBe(true);
      expect(first.claimOrdinaryLocalCommandDispatch('c1')).toBe(true);
      expect(second.claimOrdinaryLocalCommandDispatch('c1')).toBe(false);
      const reopened = open(path);
      expect(reopened.getOrdinaryLocalCommandAdmission('c1')?.state).toBe('uncertain');
      expect(reopened.deploymentStartupPending()).toBe(true);
      expect(reopened.claimOrdinaryLocalCommandDispatch('c1')).toBe(false);
      reopened.completeOrdinaryLocalCommand('c1');
      expect(first.getOrdinaryLocalCommandAdmission('c1')?.state).toBe('consumed');
      expect(first.deploymentStartupPending()).toBe(false);
      expect(first.claimOrdinaryLocalCommandDispatch('c1')).toBe(false);
    } finally {
      for (const s of stores.splice(0)) s.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('rejects drift and preserves legacy rather than enrolling it', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    expect(() =>
      store.admitOrdinaryLocalCommand({ ...meta, cwd: '/other' }, binding, input),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalCommand(
        meta,
        { ...binding, execution: { ...binding.execution, targetRevision: 't2' } },
        input,
      ),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, {
        ...input,
        clientMsgId: 'c2',
        requestFingerprint: 'fp2',
        selection: { ...input.selection, agent: { ...input.selection.agent, revision: 2 } },
      }),
    ).toThrow();
    store.upsertSession({ ...meta, sessionId: 'legacy' });
    expect(() =>
      store.admitOrdinaryLocalCommand({ ...meta, sessionId: 'legacy' }, binding, {
        ...input,
        clientMsgId: 'c3',
      }),
    ).toThrow();
    expect(store.getSessionRuntimeBinding('legacy')).toBeNull();
  });
  it('protects reserved receipts during generic restart recovery', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    store.recoverPendingSendCommands();
    expect(store.getSendCommand('c1')?.error).toBeNull();
    expect(store.claimOrdinaryLocalCommandDispatch('c1')).toBe(true);
  });
  it('refuses future commands and first admission of dormant V2 sessions', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, {
        ...input,
        clientMsgId: 'c2',
        requestFingerprint: 'fp2',
      }),
    ).toThrow(/new session/i);
    const dormant = { ...meta, sessionId: 'dormant' };
    store.createSessionWithRuntimeBinding(dormant, binding);
    expect(() =>
      store.admitOrdinaryLocalCommand(dormant, binding, {
        ...input,
        clientMsgId: 'c3',
        requestFingerprint: 'fp3',
      }),
    ).toThrow(/new session/i);
    expect(store.getSendCommand('c2')).toBeUndefined();
    expect(store.getSendCommand('c3')).toBeUndefined();
    expect(() => store.claimClientCommand('c3', 'other')).not.toThrow();
  });
  it.each([
    { source: 'inline', revision: 'r1' },
    { source: 'none', revision: 'r1' },
    { source: 'workspace', revision: null },
    { source: 'contexgin', revision: null },
    { source: 'packs', revision: null },
  ])('rejects inconsistent or invented recipe pin %j', (context) => {
    const store = open();
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, context },
      } as never),
    ).toThrow();
    expect(store.getSession('s1')).toBeNull();
  });
  it('refuses failed or native completion and fails closed on corrupt snapshots', () => {
    const store = open();
    store.admitOrdinaryLocalCommand(meta, binding, input);
    expect(() => store.completeNativeSendCommand('c1')).toThrow(/native/);
    expect(() => store.completeOrdinaryLocalCommand('c1')).toThrow(/claimed/);
    store.failSendCommand('c1', 'refused');
    expect(store.claimOrdinaryLocalCommandDispatch('c1')).toBe(false);
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
      '{"version":99}',
      'c1',
    );
    expect(() => store.getOrdinaryLocalCommandAdmission('c1')).toThrow();
    expect(() => store.claimOrdinaryLocalCommandDispatch('c1')).toThrow();
  });
  it.each(['reserved', 'uncertain', 'consumed'] as const)(
    'preserves %s through cold reopen and legacy recovery',
    (state) => {
      const dir = mkdtempSync(join(tmpdir(), 'mitzo-cold-admission-'));
      const path = join(dir, 'db');
      try {
        const first = open(path);
        first.admitOrdinaryLocalCommand(meta, binding, input);
        if (state !== 'reserved') first.claimOrdinaryLocalCommandDispatch('c1');
        if (state === 'consumed') first.completeOrdinaryLocalCommand('c1');
        first.close();
        stores.splice(stores.indexOf(first), 1);
        const reopened = open(path);
        reopened.recoverPendingSendCommands();
        expect(reopened.getOrdinaryLocalCommandAdmission('c1')?.state).toBe(state);
        expect(reopened.getSendCommand('c1')?.error).toBeNull();
        expect(reopened.admitOrdinaryLocalCommand(meta, binding, input).admission.state).toBe(
          state,
        );
        expect(reopened.claimOrdinaryLocalCommandDispatch('c1')).toBe(state === 'reserved');
      } finally {
        for (const store of stores.splice(0)) store.close();
        rmSync(dir, { recursive: true });
      }
    },
  );
  it.each([
    { agentId: 'a1', revision: 'a-r1' },
    { profileId: 'a1', revision: '1' },
    { profileId: 'a1', revision: 0 },
    { profileId: 'a1', revision: -1 },
    { profileId: 'a1', revision: 1.5 },
  ])('rejects noncanonical published profile identity %j', (agent) => {
    const store = open();
    expect(() =>
      store.admitOrdinaryLocalCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, agent },
      } as never),
    ).toThrow();
    expect(store.getSession('s1')).toBeNull();
  });
  it('rejects initial account-model contradiction without claiming or writing', () => {
    const store = open();
    expect(() =>
      store.admitOrdinaryLocalCommand(
        { ...meta, accountBinding: { ...meta.accountBinding, model: 'other' } },
        binding,
        input,
      ),
    ).toThrow(/model/i);
    expect(store.getSession('s1')).toBeNull();
    expect(store.getSendCommand('c1')).toBeUndefined();
    expect(() => store.claimClientCommand('c1', 'other')).not.toThrow();
  });
  it.each(staleOrdinaryAdmissionCases)(
    'preserves stale %s evidence while recovering unrelated legacy commands',
    (kind) => {
      const store = open();
      store.admitOrdinaryLocalCommand(meta, binding, input);
      assertStaleOrdinaryAdmissionRecovery(store, kind, () =>
        store.claimOrdinaryLocalCommandDispatch('c1'),
      );
    },
  );
});
