import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { callbackIncident as incident } from '../callback-incident-evidence.js';
const roots: string[] = [];
const binding = {
  accountId: 'fixture',
  accountLabel: 'fixture',
  provider: 'openai',
  model: 'fixture',
  profileRevision: 'fixture',
};
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'callback-repair-'));
  roots.push(root);
  const path = join(root, 'native.db');
  const store = new CodexConversationStore(path);
  store.create(incident.sessionId, binding, '/offline');
  const db = new Database(path);
  db.prepare(
    "UPDATE codex_conversations SET thread_id=?,thread_generation=2,owner_kind='ordinary',recovery=1 WHERE id=?",
  ).run(incident.threadId, incident.sessionId);
  db.prepare(
    "INSERT INTO codex_thread_generations(conversation_id,generation,thread_id,reason,created_at) VALUES(?,?,?,'initial',0)",
  ).run(incident.sessionId, 2, incident.threadId);
  const native = JSON.stringify([
    { attempt: 1, threadId: incident.threadId, turnId: incident.turnId, generation: 2 },
  ]);
  db.prepare(
    "INSERT INTO codex_commands(conversation_id,id,input,status,ambiguous,native_turns) VALUES(?,?,?,'completed',1,?)",
  ).run(
    incident.sessionId,
    incident.commandId,
    '{"id":"original","prompt":"preserve completed work"}',
    native,
  );
  for (const id of incident.queuedIds)
    db.prepare(
      "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES(?,?,?,'queued')",
    ).run(incident.sessionId, id, JSON.stringify({ id, prompt: 'preserve queued input' }));
  db.prepare(
    'INSERT INTO codex_tools(conversation_id,command_id,call_id,turn_id,tool_name,request_hash,result_content,result_is_error) VALUES(?,?,?,?,?,?,?,1)',
  ).run(
    incident.sessionId,
    incident.commandId,
    incident.callId,
    incident.turnId,
    'RequestWebAccess',
    incident.requestHash,
    incident.result,
  );
  const snapshot = () =>
    JSON.stringify({
      commands: db.prepare('SELECT * FROM codex_commands').all(),
      tools: db.prepare('SELECT * FROM codex_tools').all(),
    });
  return {
    store,
    db,
    root,
    snapshot,
    close: () => {
      db.close();
      store.close();
    },
  };
}
it('reconciles only the selected flags, with a private backup and separate idempotent audit; never claims queued inputs or invents a phase', () => {
  const f = fixture();
  try {
    const original = f.snapshot();
    const plan = f.store.inspectCallbackIncident(binding);
    expect(
      f.store.applyCallbackIncident(binding, plan, {
        evidenceHash: 'a'.repeat(64),
        operatorHash: 'b'.repeat(64),
      }),
    ).toEqual({ status: 'reconciled' });
    const rows = f.db.prepare('SELECT * FROM codex_commands ORDER BY sequence').all() as Array<
      Record<string, unknown>
    >;
    expect(rows[0]).toMatchObject({
      status: 'completed',
      attempt: 1,
      ambiguous: 0,
      recovery_acknowledged: 1,
      completion_phases: null,
    });
    expect(rows.slice(1).map((row) => [row.id, row.status, row.attempt, row.native_turns])).toEqual(
      incident.queuedIds.map((id) => [id, 'queued', 1, null]),
    );
    const audit = f.db.prepare('SELECT * FROM codex_callback_incident_repairs').get() as {
      backup_path: string;
    };
    expect(readFileSync(audit.backup_path, 'utf8')).toContain('preserve queued input');
    expect(
      f.store.applyCallbackIncident(binding, plan, {
        evidenceHash: 'a'.repeat(64),
        operatorHash: 'b'.repeat(64),
      }),
    ).toEqual({ status: 'already_reconciled' });
    const restored = JSON.parse(f.snapshot());
    const before = JSON.parse(original);
    restored.commands[0].ambiguous = 1;
    restored.commands[0].recovery_acknowledged = 0;
    expect(restored).toEqual(before);
  } finally {
    f.close();
  }
});
it.each([
  'new input',
  'changed result',
  'pending tool',
  'other ambiguity',
  'pending dispatch',
  'wrong lineage',
])('refuses %s and leaves all state untouched', (change) => {
  const f = fixture();
  try {
    const plan = f.store.inspectCallbackIncident(binding);
    if (change === 'new input')
      f.db
        .prepare(
          "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES(?,'new','{}','queued')",
        )
        .run(incident.sessionId);
    if (change === 'changed result')
      f.db.prepare("UPDATE codex_tools SET result_content='changed'").run();
    if (change === 'pending tool') f.db.prepare('UPDATE codex_tools SET result_content=NULL').run();
    if (change === 'other ambiguity')
      f.db
        .prepare("UPDATE codex_commands SET ambiguous=1,status='interrupted' WHERE id=?")
        .run(incident.queuedIds[0]);
    if (change === 'pending dispatch')
      f.db
        .prepare(
          'INSERT INTO codex_pending_thread_dispatches(conversation_id,thread_id,command_id,attempt) VALUES(?,?,?,1)',
        )
        .run(incident.sessionId, incident.threadId, incident.commandId);
    if (change === 'wrong lineage')
      f.db.prepare('UPDATE codex_conversations SET thread_generation=3').run();
    const before = f.snapshot();
    expect(() =>
      f.store.applyCallbackIncident(binding, plan, {
        evidenceHash: 'a'.repeat(64),
        operatorHash: 'b'.repeat(64),
      }),
    ).toThrow();
    expect(f.snapshot()).toEqual(before);
  } finally {
    f.close();
  }
});
