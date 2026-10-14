import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
const binding = {
  version: 2,
  account: { accountId: 'personal', provider: 'anthropic-vertex', profileRevision: 'p1' },
  harness: { implementation: 'claude-sdk' },
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
describe('ordinary Local Vertex durable command admission', () => {
  it('atomically freezes settings and exact retries without allocating execution', () => {
    const store = open();
    expect(store.admitOrdinaryLocalVertexCommand(meta, binding, input).duplicate).toBe(false);
    expect(store.admitOrdinaryLocalVertexCommand(meta, binding, input).duplicate).toBe(true);
    expect(store.getOrdinaryLocalVertexCommandAdmission('c1')?.selection).toEqual(input.selection);
    expect(store.getExecutionAdmission('s1', 'c1')).toBeUndefined();
    expect(store.getOrdinaryLocalCommandAdmission('c1')).toBeUndefined();
    expect(() => store.claimOrdinaryLocalCommandDispatch('c1')).toThrow();
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, model: 'different' },
      }),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        payload: { prompt: 'changed' },
      }),
    ).toThrow();
  });
  it('rolls back binding and global identity when receipt insertion fails', () => {
    const store = open();
    vi.spyOn(store, 'insertSendCommand').mockImplementation(() => {
      throw new Error('injected');
    });
    expect(() => store.admitOrdinaryLocalVertexCommand(meta, binding, input)).toThrow('injected');
    expect(store.getSession('s1')).toBeNull();
    expect(() => store.claimClientCommand('c1', 'different')).not.toThrow();
  });
  it('retains non-replay uncertainty across competing stores and cold reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-admission-'));
    const path = join(dir, 'db');
    try {
      const first = open(path),
        second = open(path);
      first.admitOrdinaryLocalVertexCommand(meta, binding, input);
      expect(second.admitOrdinaryLocalVertexCommand(meta, binding, input).duplicate).toBe(true);
      expect(first.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(true);
      expect(second.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(false);
      const reopened = open(path);
      expect(reopened.getOrdinaryLocalVertexCommandAdmission('c1')?.state).toBe('uncertain');
      expect(reopened.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(false);
      reopened.completeOrdinaryLocalVertexCommand('c1');
      expect(first.getOrdinaryLocalVertexCommandAdmission('c1')?.state).toBe('consumed');
      expect(first.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(false);
    } finally {
      for (const s of stores.splice(0)) s.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('rejects drift and preserves legacy rather than enrolling it', () => {
    const store = open();
    store.admitOrdinaryLocalVertexCommand(meta, binding, input);
    expect(() =>
      store.admitOrdinaryLocalVertexCommand({ ...meta, cwd: '/other' }, binding, input),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(
        meta,
        { ...binding, execution: { ...binding.execution, targetRevision: 't2' } },
        input,
      ),
    ).toThrow();
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        clientMsgId: 'c2',
        requestFingerprint: 'fp2',
        selection: { ...input.selection, agent: { ...input.selection.agent, revision: 2 } },
      }),
    ).toThrow();
    store.upsertSession({ ...meta, sessionId: 'legacy' });
    expect(() =>
      store.admitOrdinaryLocalVertexCommand({ ...meta, sessionId: 'legacy' }, binding, {
        ...input,
        clientMsgId: 'c3',
      }),
    ).toThrow();
    expect(store.getSessionRuntimeBinding('legacy')).toBeNull();
  });
  it('protects reserved receipts during generic restart recovery', () => {
    const store = open();
    store.admitOrdinaryLocalVertexCommand(meta, binding, input);
    store.recoverPendingSendCommands();
    expect(store.getSendCommand('c1')?.error).toBeNull();
    expect(store.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(true);
  });
  it('refuses future commands and first admission of dormant V2 sessions', () => {
    const store = open();
    store.admitOrdinaryLocalVertexCommand(meta, binding, input);
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        clientMsgId: 'c2',
        requestFingerprint: 'fp2',
      }),
    ).toThrow(/new session/i);
    const dormant = { ...meta, sessionId: 'dormant' };
    store.createSessionWithRuntimeBinding(dormant, binding);
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(dormant, binding, {
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
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, context },
      } as never),
    ).toThrow();
    expect(store.getSession('s1')).toBeNull();
  });
  it('refuses failed or native completion and fails closed on corrupt snapshots', () => {
    const store = open();
    store.admitOrdinaryLocalVertexCommand(meta, binding, input);
    expect(() => store.completeNativeSendCommand('c1')).toThrow(/native/);
    expect(() => store.completeOrdinaryLocalVertexCommand('c1')).toThrow(/claimed/);
    store.failSendCommand('c1', 'refused');
    expect(store.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(false);
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
      '{"version":99}',
      'c1',
    );
    expect(() => store.getOrdinaryLocalVertexCommandAdmission('c1')).toThrow();
    expect(() => store.claimOrdinaryLocalVertexCommandDispatch('c1')).toThrow();
  });
  it.each(['reserved', 'uncertain', 'consumed'] as const)(
    'preserves %s through cold reopen and legacy recovery',
    (state) => {
      const dir = mkdtempSync(join(tmpdir(), 'mitzo-cold-admission-'));
      const path = join(dir, 'db');
      try {
        const first = open(path);
        first.admitOrdinaryLocalVertexCommand(meta, binding, input);
        if (state !== 'reserved') first.claimOrdinaryLocalVertexCommandDispatch('c1');
        if (state === 'consumed') first.completeOrdinaryLocalVertexCommand('c1');
        first.close();
        stores.splice(stores.indexOf(first), 1);
        const reopened = open(path);
        reopened.recoverPendingSendCommands();
        expect(reopened.getOrdinaryLocalVertexCommandAdmission('c1')?.state).toBe(state);
        expect(reopened.getSendCommand('c1')?.error).toBeNull();
        expect(reopened.admitOrdinaryLocalVertexCommand(meta, binding, input).admission.state).toBe(
          state,
        );
        expect(reopened.claimOrdinaryLocalVertexCommandDispatch('c1')).toBe(state === 'reserved');
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
      store.admitOrdinaryLocalVertexCommand(meta, binding, {
        ...input,
        selection: { ...input.selection, agent },
      } as never),
    ).toThrow();
    expect(store.getSession('s1')).toBeNull();
  });
  it('rejects initial account-model contradiction without claiming or writing', () => {
    const store = open();
    expect(() =>
      store.admitOrdinaryLocalVertexCommand(
        { ...meta, accountBinding: { ...meta.accountBinding, model: 'other' } },
        binding,
        input,
      ),
    ).toThrow(/model/i);
    expect(store.getSession('s1')).toBeNull();
    expect(store.getSendCommand('c1')).toBeUndefined();
    expect(() => store.claimClientCommand('c1', 'other')).not.toThrow();
  });
  it.each(['runtime', 'admission', 'empty-admission'] as const)(
    'preserves corrupt %s evidence and refuses generic recovery',
    (kind) => {
      const store = open();
      store.admitOrdinaryLocalVertexCommand(meta, binding, input);
      const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
      if (kind === 'runtime')
        db.prepare('UPDATE sessions SET runtime_binding=? WHERE session_id=?').run(
          '{"version":99}',
          's1',
        );
      else
        db.prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?').run(
          kind === 'empty-admission' ? '' : '{"version":99}',
          'c1',
        );
      const receiptBefore = db
        .prepare('SELECT * FROM send_commands WHERE client_msg_id=?')
        .get('c1');
      const sessionBefore = db.prepare('SELECT * FROM sessions WHERE session_id=?').get('s1');
      const eventsBefore = db.prepare('SELECT * FROM events WHERE session_id=?').all('s1');
      expect(() => store.recoverPendingSendCommands()).toThrow();
      expect(() => store.claimOrdinaryLocalVertexCommandDispatch('c1')).toThrow();
      expect(db.prepare('SELECT * FROM send_commands WHERE client_msg_id=?').get('c1')).toEqual(
        receiptBefore,
      );
      expect(db.prepare('SELECT * FROM sessions WHERE session_id=?').get('s1')).toEqual(
        sessionBefore,
      );
      expect(db.prepare('SELECT * FROM events WHERE session_id=?').all('s1')).toEqual(eventsBefore);
    },
  );
});

it('retains exact private SDK thread, operator and ADC custody across reload without public metadata leakage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-vertex-custody-'));
  try {
    const store = open(join(directory, 'events.db'));
    store.admitOrdinaryLocalVertexCommand(meta, binding, input);
    const custody = {
      version: 1,
      sessionId: 's1',
      sdkSessionId: '1f736f65-0b10-4c66-9e57-8f183ed81b69',
      authSessionId: 'original-auth',
      initialCommandId: 'c1',
      repositoryWorkspaceId: 'w1',
      cwd: '/task',
      binding,
      credentialAuthority: {
        version: 1,
        project: 'original-project',
        region: 'original-region',
        adc: {
          path: '/private/fixture-adc',
          parentDev: '1',
          parentIno: '2',
          dev: '1',
          ino: '3',
          uid: '501',
          mode: '33152',
          nlink: '1',
          sha256: 'a'.repeat(64),
        },
      },
    };
    expect(store.retainOrdinaryLocalVertexCustody(custody)).toEqual(custody);
    const reopened = open(join(directory, 'events.db'));
    expect(reopened.getOrdinaryLocalVertexCustody('s1')).toEqual(custody);
    expect(JSON.stringify(reopened.getSession('s1'))).not.toContain('original-auth');
    expect(JSON.stringify(reopened.getSession('s1'))).not.toContain('fixture-adc');
    expect(() =>
      reopened.retainOrdinaryLocalVertexCustody({ ...custody, authSessionId: 'replacement-auth' }),
    ).toThrow();
    expect(() =>
      reopened.retainOrdinaryLocalVertexCustody({
        ...custody,
        sdkSessionId: '59641f1f-130d-4db6-b093-591185fb6c94',
      }),
    ).toThrow();
    expect(() =>
      reopened.retainOrdinaryLocalVertexCustody({
        ...custody,
        credentialAuthority: { ...custody.credentialAuthority, project: 'replacement-project' },
      }),
    ).toThrow();
    expect(reopened.getOrdinaryLocalVertexCustody('s1')).toEqual(custody);
  } finally {
    for (const store of stores.splice(0)) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
