import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const scope = {
  conversationId: 'target',
  childThreadId: 'ghost',
  parentThreadId: 'parent',
  createdAt: 2,
  bindingSha256: sha(JSON.stringify(['account', 'openai-codex', 'model', 'revision'])),
  candidatePhysicalId: 'physical',
  sourcePhysicalId: 'source-id',
  commands: [
    { sequence: 269, id: 'old1', inputSha256: sha('PRIVATE_HISTORY') },
    { sequence: 270, id: 'old2', inputSha256: sha('PRIVATE_HISTORY') },
  ],
};
const quarantine = (o) => quarantineScoped(scope, o);
import {
  fingerprint,
  snapshot,
  quarantineScoped,
  quarantine as exactQuarantine,
  collectDispatchProof,
  ownedInputFile,
} from '../repair-unpersisted-thread.mjs';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE codex_conversations(id TEXT PRIMARY KEY,binding TEXT,thread_id TEXT,thread_generation INTEGER,artifact_runtime TEXT,tool_surface_revision TEXT,rollover_context TEXT,owner_kind TEXT);
    CREATE TABLE codex_thread_generations(conversation_id TEXT,generation INTEGER,thread_id TEXT,parent_thread_id TEXT,reason TEXT,last_completed_turn_id TEXT,created_at INTEGER,retired_at INTEGER);
    CREATE TABLE codex_commands(conversation_id TEXT,id TEXT,status TEXT,sequence INTEGER,attempt INTEGER,ambiguous INTEGER,recovery_acknowledged INTEGER,input TEXT);
    CREATE TABLE codex_knowledge_adoptions(conversation_id TEXT,thread_id TEXT,selection TEXT);
    CREATE TABLE codex_tools(conversation_id TEXT,id TEXT);
    CREATE TABLE codex_runtime_migrations(conversation_id TEXT,binding TEXT,generation INTEGER,data TEXT);
    CREATE TABLE events(seq INTEGER PRIMARY KEY,session_id TEXT,type TEXT,payload TEXT,created_at INTEGER);
    CREATE TABLE execution_admissions(session_id TEXT,created_at INTEGER);
    CREATE TABLE send_commands(session_id TEXT,created_at INTEGER);
    CREATE TABLE provider_attempts(session_id TEXT);
    CREATE TABLE codex_pending_thread_dispatches(conversation_id TEXT,parent_thread_id TEXT,thread_id TEXT,command_id TEXT,attempt INTEGER);`);
  const binding = JSON.stringify(['account', 'openai-codex', 'model', 'revision']);
  const runtime = {
    sandboxName: 'candidate',
    sandboxId: 'physical',
    workspace: 'default',
    gateway: 'openshell',
    workdir: '/sandbox/workspaces/mgmt',
  };
  const artifact = { runtime, route: { kind: 'api-key', provider: 'selected-provider' } };
  db.prepare('INSERT INTO codex_conversations VALUES(?,?,?,?,?,?,?,?)').run(
    'target',
    binding,
    'ghost',
    1,
    JSON.stringify(artifact),
    'previous-tools',
    'retained-context',
    'ordinary',
  );
  db.prepare('INSERT INTO codex_thread_generations VALUES(?,?,?,?,?,?,?,?)').run(
    'target',
    0,
    'parent',
    null,
    'initial',
    'completed-parent-turn',
    1,
    2,
  );
  db.prepare('INSERT INTO codex_thread_generations VALUES(?,?,?,?,?,?,?,?)').run(
    'target',
    1,
    'ghost',
    'parent',
    'tool_surface_change',
    null,
    2,
    null,
  );
  for (const id of ['old1', 'old2'])
    db.prepare('INSERT INTO codex_commands VALUES(?,?,?,?,?,?,?,?)').run(
      'target',
      id,
      'completed',
      id === 'old1' ? 269 : 270,
      1,
      null,
      0,
      'PRIVATE_HISTORY',
    );
  const migration = {
    phase: 'committed',
    source: { runtime: { sandboxId: 'source-id' } },
    candidateName: 'candidate',
    candidate: artifact,
    identity: { thread: 'parent' },
    checkpoint: { path: '/private/archive', digest: 'unchanged' },
  };
  db.prepare('INSERT INTO codex_runtime_migrations VALUES(?,?,?,?)').run(
    'target',
    binding,
    13,
    JSON.stringify(migration),
  );
  const expected = snapshot(db, 'target');
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
    1,
    'target',
    'user_message',
    JSON.stringify({ messageId: 'old1', prompt: 'PRIVATE_MESSAGE' }),
    0,
  );
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(
    2,
    'target',
    'user_message',
    JSON.stringify({ messageId: 'old2', prompt: 'PRIVATE_MESSAGE' }),
    1,
  );
  const dispatchProof = collectDispatchProof(db, scope);
  const evidence = {
    conversationId: 'target',
    childThreadId: 'ghost',
    parentThreadId: 'parent',
    bindingSha256: scope.bindingSha256,
    dispatchProof,
    observedAt: 1000,
    source: {
      physicalId: 'source-id',
      nativeAppServerCount: 0,
      parentRolloutCount: 1,
      parentThreadRowCount: 1,
      childRolloutCount: 0,
      childThreadRowCount: 0,
    },
    candidate: {
      physicalId: 'physical',
      nativeAppServerCount: 0,
      parentRolloutCount: 1,
      parentThreadRowCount: 1,
      childRolloutCount: 0,
      childThreadRowCount: 0,
    },
    contractVerified: true,
    lifecycleEnabled: false,
  };
  return { db, expected, evidence };
}
const options = (f) => ({
  db: f.db,
  expected: f.expected,
  evidence: f.evidence,
  now: 1001,
  assertServerOff: () => true,
  confirmedHeldInputs: true,
  readDispatchProof: () => collectDispatchProof(f.db, scope),
});

describe('scoped unpersisted thread quarantine CAS', () => {
  it('changes only revision and audit, preserving ghost, parent, checkpoint, histories and FIFO', () => {
    const f = fixture();
    const before = fingerprint(f.db.prepare('SELECT * FROM codex_commands').all());
    const history = fingerprint(f.db.prepare('SELECT * FROM codex_thread_generations').all());
    const migration = fingerprint(f.db.prepare('SELECT * FROM codex_runtime_migrations').all());
    const result = quarantine({ ...options(f), apply: true });
    expect(result.applied).toBe(true);
    expect(
      f.db
        .prepare(
          'SELECT thread_id,thread_generation,tool_surface_revision,rollover_context FROM codex_conversations',
        )
        .get(),
    ).toEqual({
      thread_id: 'ghost',
      thread_generation: 1,
      tool_surface_revision: null,
      rollover_context: 'retained-context',
    });
    expect(fingerprint(f.db.prepare('SELECT * FROM codex_commands').all())).toBe(before);
    expect(fingerprint(f.db.prepare('SELECT * FROM codex_thread_generations').all())).toBe(history);
    expect(fingerprint(f.db.prepare('SELECT * FROM codex_runtime_migrations').all())).toBe(
      migration,
    );
    expect(
      f.db.prepare('SELECT count(*) n FROM codex_unpersisted_thread_quarantines').get().n,
    ).toBe(1);
  });
  it('dry-run creates no marker and changes nothing', () => {
    const f = fixture();
    expect(quarantine(options(f)).applied).toBe(false);
    expect(snapshot(f.db, 'target')).toEqual(f.expected);
    expect(
      f.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='codex_unpersisted_thread_quarantines'",
        )
        .get().n,
    ).toBe(0);
  });
  for (const [name, mutate] of [
    [
      'ambiguous outcome',
      (f) => f.db.exec("UPDATE codex_commands SET ambiguous=1 WHERE id='old2'"),
    ],
    [
      'queued target input',
      (f) => f.db.exec("UPDATE codex_commands SET status='queued' WHERE id='old2'"),
    ],
    ['racing mapping', (f) => f.db.exec("UPDATE codex_conversations SET thread_id='raced'")],
    ['account mismatch', (f) => f.db.exec("UPDATE codex_conversations SET binding='different'")],
    [
      'receipt change',
      (f) => f.db.exec("INSERT INTO codex_knowledge_adoptions VALUES('target','ghost','{}')"),
    ],
    [
      'pending dispatch',
      (f) =>
        f.db.exec(
          "INSERT INTO codex_pending_thread_dispatches VALUES('target','ghost','new','cmd',1)",
        ),
    ],
  ])
    it(`refuses ${name} without changing revision or audit`, () => {
      const f = fixture();
      mutate(f);
      expect(() => quarantine({ ...options(f), apply: true })).toThrow();
      expect(f.db.prepare('SELECT tool_surface_revision r FROM codex_conversations').get().r).toBe(
        'previous-tools',
      );
      expect(
        f.db
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE name='codex_unpersisted_thread_quarantines'",
          )
          .get().n,
      ).toBe(0);
    });
  it('refuses live server, stale evidence, lifecycle capture, or existing child native history', () => {
    for (const change of [
      (o) => (o.assertServerOff = () => false),
      (o) => (o.now = 40000),
      (o) => (o.evidence = { ...o.evidence, lifecycleEnabled: true }),
      (o) =>
        (o.evidence = {
          ...o.evidence,
          candidate: { ...o.evidence.candidate, childThreadRowCount: 1 },
        }),
    ]) {
      const f = fixture();
      const o = { ...options(f), apply: true };
      change(o);
      expect(() => quarantine(o)).toThrow();
      expect(f.db.prepare('SELECT tool_surface_revision r FROM codex_conversations').get().r).toBe(
        'previous-tools',
      );
    }
  });
  it('rechecks synchronous server fence inside CAS and delivers no mutation if it changed', () => {
    const f = fixture();
    let calls = 0;
    expect(() =>
      quarantine({ ...options(f), apply: true, assertServerOff: () => ++calls < 2 }),
    ).toThrow();
    expect(f.db.prepare('SELECT tool_surface_revision r FROM codex_conversations').get().r).toBe(
      'previous-tools',
    );
  });
  it('refuses provider evidence for another child even if counts match', () => {
    const f = fixture();
    f.evidence.childThreadId = 'different';
    expect(() => quarantine({ ...options(f), apply: true })).toThrow();
  });
  it('production entrypoint refuses a different conversation even if generic fixture is eligible', () => {
    const f = fixture();
    expect(() => exactQuarantine({ ...options(f), apply: true })).toThrow(
      'reviewed_exact_target_required',
    );
  });
  it('refuses authoritative dispatch evidence and historical input drift', () => {
    const f = fixture();
    f.evidence.dispatchProof.postCutAdmissionCount = 1;
    expect(() => quarantine({ ...options(f), apply: true })).toThrow();
    const g = fixture();
    g.db.exec("UPDATE codex_commands SET input='changed'");
    expect(() => quarantine({ ...options(g), apply: true })).toThrow();
  });
  it('refuses newly discovered protocol admission or provider event', () => {
    for (const sql of [
      "INSERT INTO execution_admissions VALUES('target',3)",
      "INSERT INTO send_commands VALUES('target',3)",
      "INSERT INTO provider_attempts VALUES('target')",
      "INSERT INTO events VALUES(3,'target','message_start','{}',3)",
    ]) {
      const f = fixture();
      f.db.exec(sql);
      expect(() => quarantine({ ...options(f), apply: true })).toThrow();
      expect(f.db.prepare('SELECT tool_surface_revision r FROM codex_conversations').get().r).toBe(
        'previous-tools',
      );
    }
  });
  it('refuses repeated repair instead of erasing audit', () => {
    const f = fixture();
    quarantine({ ...options(f), apply: true });
    expect(() => quarantine({ ...options(f), apply: true })).toThrow();
    expect(
      f.db.prepare('SELECT count(*) n FROM codex_unpersisted_thread_quarantines').get().n,
    ).toBe(1);
  });
});

describe('existing authoritative input permissions', () => {
  it('accepts owned0644 databases without chmod, but refuses them as private environments', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quarantine-mode-')));
    try {
      const path = join(dir, 'existing.db');
      writeFileSync(path, 'fixture');
      chmodSync(path, 0o644);
      expect(ownedInputFile(path, false)).toBe(path);
      expect(() => ownedInputFile(path, true)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses group writable databases', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quarantine-mode-')));
    try {
      const path = join(dir, 'existing.db');
      writeFileSync(path, 'fixture');
      chmodSync(path, 0o664);
      expect(() => ownedInputFile(path, false)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
