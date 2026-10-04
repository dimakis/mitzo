#!/usr/bin/env node
// Explicit offline quarantine. Never resumes a thread, restarts a service or changes a queue.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
export const LEGACY_SCOPE = Object.freeze({
  conversationId: 'b6482bac-5144-4afc-b042-af148a339e9b',
  childThreadId: '01a103d1-d79f-7323-a217-0b108f44ed7b',
  parentThreadId: '01a0fe69-4d0c-7423-98fa-8f07e12fae9c',
  createdAt: 1791065446293,
  bindingSha256: '3bffc5b0adae52312fb518f2f72e935b49aa120caf7cba6878225e482421979a',
  candidatePhysicalId: 'c68cb453-7eea-47b5-9401-ded57334c424',
  sourcePhysicalId: 'c16a46db-96e7-48bf-b372-bb528c36a823',
  commands: [
    {
      sequence: 269,
      id: 'user-1790974704832-uvedku',
      inputSha256: '570732369ff71af1119ad3657ac4c936ed6754cac96181fd2ed9b919c9fca7d1',
    },
    {
      sequence: 270,
      id: 'user-1790974779324-j6tf8b',
      inputSha256: '396da1d1712dbc598c81ffa2318a878f6bda12d78a947709dd3bfcebe8c16c59',
    },
  ],
});
function bytesSha(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function need(ok, code) {
  if (!ok) throw new Error(code);
}
function rows(db, table, id) {
  return db
    .prepare(`SELECT * FROM ${table} ${id ? 'WHERE conversation_id=?' : ''} ORDER BY rowid`)
    .all(...(id ? [id] : []));
}
function exists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
export function snapshot(db, id) {
  const row = db.prepare('SELECT * FROM codex_conversations WHERE id=?').get(id);
  need(row, 'selected_conversation_missing');
  const migration = db
    .prepare('SELECT * FROM codex_runtime_migrations WHERE conversation_id=?')
    .get(id);
  const generations = rows(db, 'codex_thread_generations', id);
  const current = generations.find((g) => g.generation === row.thread_generation);
  const artifact = JSON.parse(row.artifact_runtime);
  return {
    version: 1,
    conversationId: id,
    threadId: row.thread_id,
    generation: row.thread_generation,
    parentThreadId: current?.parent_thread_id,
    candidatePhysicalId: artifact.runtime.sandboxId,
    conversationFingerprint: fingerprint(row),
    migrationFingerprint: fingerprint(migration),
    generationFingerprint: fingerprint(generations),
    commandsFingerprint: fingerprint(rows(db, 'codex_commands')),
    receiptsFingerprint: fingerprint(rows(db, 'codex_knowledge_adoptions')),
    toolsFingerprint: fingerprint(rows(db, 'codex_tools')),
    pendingDispatchFingerprint: fingerprint(
      exists(db, 'codex_pending_thread_dispatches')
        ? rows(db, 'codex_pending_thread_dispatches')
        : [],
    ),
  };
}
export function quarantine(options) {
  return quarantineScoped(LEGACY_SCOPE, options);
}
// Explicit scope dependency permits synthetic offline fixtures; the CLI has no scope override.
export function quarantineScoped(
  scope,
  {
    db,
    expected,
    evidence,
    now = Date.now(),
    assertServerOff,
    confirmedHeldInputs,
    readDispatchProof,
    apply = false,
  },
) {
  need(
    expected.conversationId === scope.conversationId &&
      expected.threadId === scope.childThreadId &&
      expected.parentThreadId === scope.parentThreadId,
    'reviewed_exact_target_required',
  );
  need(
    evidence.conversationId === scope.conversationId &&
      evidence.childThreadId === scope.childThreadId &&
      evidence.parentThreadId === scope.parentThreadId &&
      evidence.bindingSha256 === scope.bindingSha256,
    'provider_evidence_identity_changed',
  );
  need(typeof readDispatchProof === 'function', 'authoritative_dispatch_proof_required');
  need(confirmedHeldInputs === true, 'confirmed_held_inputs_required');
  need(assertServerOff() === true, 'server_off_fence_required');
  need(
    evidence?.contractVerified === true && evidence.lifecycleEnabled === false,
    'contract_or_lifecycle_not_safe',
  );
  need(
    Number.isSafeInteger(evidence.observedAt) &&
      now >= evidence.observedAt &&
      now - evidence.observedAt <= 15000,
    'provider_evidence_not_fresh',
  );
  for (const scope of ['source', 'candidate']) {
    const e = evidence[scope];
    need(
      e &&
        e.parentRolloutCount === 1 &&
        e.parentThreadRowCount === 1 &&
        e.childRolloutCount === 0 &&
        e.childThreadRowCount === 0 &&
        e.nativeAppServerCount === 0,
      'native_thread_evidence_differs',
    );
  }
  const validate = () => {
    need(
      fingerprint(snapshot(db, expected.conversationId)) === fingerprint(expected),
      'repair_snapshot_changed',
    );
    const row = db
      .prepare('SELECT * FROM codex_conversations WHERE id=?')
      .get(expected.conversationId);
    const generations = rows(db, 'codex_thread_generations', row.id);
    const current = generations.find((g) => g.generation === 1);
    const parent = generations.find((g) => g.generation === 0);
    need(bytesSha(row.binding) === scope.bindingSha256, 'reviewed_binding_changed');
    const dispatch = readDispatchProof();
    need(
      dispatch.conversationId === scope.conversationId &&
        dispatch.cutoff === scope.createdAt &&
        dispatch.postCutAdmissionCount === 0 &&
        dispatch.postCutSendCount === 0 &&
        dispatch.providerAttemptCount === 0 &&
        dispatch.postCutProviderEventCount === 0 &&
        dispatch.historicMessages.length === 2 &&
        dispatch.historicMessages.every(
          (m, i) =>
            m.id === scope.commands[i].id &&
            Number.isSafeInteger(m.createdAt) &&
            m.createdAt < scope.createdAt,
        ),
      'authoritative_no_dispatch_proof_changed',
    );
    need(
      fingerprint(dispatch) === fingerprint(evidence.dispatchProof),
      'dispatch_proof_changed_during_repair',
    );
    need(
      row.owner_kind === 'ordinary' &&
        row.thread_generation === 1 &&
        row.tool_surface_revision !== null,
      'unsupported_legacy_repair_scope',
    );
    need(
      current?.reason === 'tool_surface_change' &&
        current.thread_id === row.thread_id &&
        current.created_at === scope.createdAt &&
        current.last_completed_turn_id === null &&
        current.retired_at === null &&
        parent?.thread_id === current.parent_thread_id &&
        parent.last_completed_turn_id &&
        parent.retired_at === current.created_at,
      'legacy_generation_relation_differs',
    );
    const migration = db
      .prepare('SELECT * FROM codex_runtime_migrations WHERE conversation_id=?')
      .get(row.id);
    const relation = JSON.parse(migration.data);
    const artifact = JSON.parse(row.artifact_runtime);
    need(
      migration.generation === 13 &&
        migration.binding === row.binding &&
        relation.phase === 'committed' &&
        relation.checkpoint &&
        relation.identity.thread === parent.thread_id &&
        relation.candidateName === artifact.runtime.sandboxName &&
        fingerprint(relation.candidate) === fingerprint(artifact),
      'legacy_migration_relation_differs',
    );
    need(
      evidence.candidate.physicalId === scope.candidatePhysicalId &&
        evidence.candidate.physicalId === artifact.runtime.sandboxId &&
        evidence.source.physicalId === scope.sourcePhysicalId &&
        evidence.source.physicalId === relation.source?.runtime.sandboxId,
      'provider_physical_identity_changed',
    );
    const commands = rows(db, 'codex_commands', row.id);
    need(
      commands.length === 2 &&
        commands.every(
          (c, i) =>
            c.status === 'completed' &&
            (c.ambiguous === 0 || c.ambiguous === null) &&
            c.id === scope.commands[i].id &&
            c.sequence === scope.commands[i].sequence &&
            bytesSha(c.input) === scope.commands[i].inputSha256,
        ),
      'legacy_target_commands_not_safe',
    );
    need(
      rows(db, 'codex_knowledge_adoptions', row.id).every((r) => r.thread_id !== current.thread_id),
      'replacement_acknowledgment_exists',
    );
    need(
      !exists(db, 'codex_pending_thread_dispatches') ||
        rows(db, 'codex_pending_thread_dispatches', row.id).length === 0,
      'pending_dispatch_requires_separate_recovery',
    );
    need(
      !exists(db, 'codex_unpersisted_thread_quarantines') ||
        !db
          .prepare('SELECT 1 FROM codex_unpersisted_thread_quarantines WHERE conversation_id=?')
          .get(row.id),
      'quarantine_already_recorded',
    );
    return row;
  };
  validate();
  if (!apply)
    return {
      applied: false,
      snapshotFingerprint: fingerprint(expected),
      modelCalls: 0,
      serviceActions: 0,
    };
  return db
    .transaction(() => {
      const row = validate();
      // Synchronous fence and SQLite CAS; no asynchronous native operation follows.
      need(assertServerOff() === true, 'server_off_fence_changed');
      db.exec(`CREATE TABLE IF NOT EXISTS codex_unpersisted_thread_quarantines (
      conversation_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, thread_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, provider_evidence_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL, reason TEXT NOT NULL)`);
      const changed = db
        .prepare(
          `UPDATE codex_conversations SET tool_surface_revision=NULL
      WHERE id=? AND binding=? AND thread_id=? AND thread_generation=? AND tool_surface_revision IS ? AND artifact_runtime=?`,
        )
        .run(
          row.id,
          row.binding,
          row.thread_id,
          row.thread_generation,
          row.tool_surface_revision,
          row.artifact_runtime,
        );
      need(changed.changes === 1, 'repair_mapping_cas_failed');
      db.prepare('INSERT INTO codex_unpersisted_thread_quarantines VALUES(?,?,?,?,?,?,?,?)').run(
        row.id,
        row.thread_generation,
        row.thread_id,
        expected.parentThreadId,
        fingerprint(expected),
        fingerprint(evidence),
        now,
        'proven_unpersisted_tool_surface_child',
      );
      return {
        applied: true,
        snapshotFingerprint: fingerprint(expected),
        modelCalls: 0,
        serviceActions: 0,
      };
    })
    .immediate();
}

export function collectDispatchProof(db, scope = LEGACY_SCOPE) {
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  return {
    conversationId: scope.conversationId,
    cutoff: scope.createdAt,
    postCutAdmissionCount: count(
      'SELECT count(*) n FROM execution_admissions WHERE session_id=? AND created_at>=?',
      scope.conversationId,
      scope.createdAt,
    ),
    postCutSendCount: count(
      'SELECT count(*) n FROM send_commands WHERE session_id=? AND created_at>=?',
      scope.conversationId,
      scope.createdAt,
    ),
    providerAttemptCount: count(
      'SELECT count(*) n FROM provider_attempts WHERE session_id=?',
      scope.conversationId,
    ),
    postCutProviderEventCount: count(
      "SELECT count(*) n FROM events WHERE session_id=? AND created_at>=? AND type NOT IN ('user_message','error')",
      scope.conversationId,
      scope.createdAt,
    ),
    historicMessages: scope.commands.map((c) => {
      const matches = db
        .prepare(
          "SELECT created_at FROM events WHERE session_id=? AND type='user_message' AND json_extract(payload,'$.messageId')=?",
        )
        .all(scope.conversationId, c.id);
      need(matches.length === 1, 'historic_message_provenance_changed');
      return { id: c.id, createdAt: matches[0].created_at };
    }),
    eventsFingerprint: fingerprint(
      db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(scope.conversationId),
    ),
  };
}

export function ownedInputFile(path, privateMode = true) {
  need(isAbsolute(path) && realpathSync(path) === path, 'physical_input_path_required');
  const s = lstatSync(path);
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & (privateMode ? 0o077 : 0o022)) === 0,
    'owned_input_mode_required',
  );
  return path;
}
