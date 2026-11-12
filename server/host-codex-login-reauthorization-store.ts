import type Database from 'better-sqlite3';
import type { AccountBinding } from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import { HostCodexLoginReauthorization } from './host-codex-login-reauthorization.js';
import type { HostCodexCustody } from './host-codex-custody.js';

/** Only the native conversation owner supplies these fresh observations. */
export function reauthorizeHostLoginStore(
  db: Database.Database,
  id: string,
  binding: AccountBinding,
  operation: HostCodexLoginReauthorization,
  approvedOperationId: string,
  owner: {
    read(): unknown;
    custody(): HostCodexCustody | null;
    hasRunningCommand(): boolean;
    assertNoPendingThreadDispatch(): void;
    assertNoPendingThreadOwnership(): void;
  },
): { status: 'completed' | 'already_completed'; operationId: string } {
  if (
    !(operation instanceof HostCodexLoginReauthorization) ||
    approvedOperationId !== operation.operationId ||
    !isDeepStrictEqual(operation.binding(), binding)
  )
    throw Error('Exact reviewed login reauthorization required');
  owner.read();
  const read = () => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_login_reauthorizations'",
        )
        .get()
    )
      return undefined;
    return db
      .prepare(
        'SELECT conversation_id,original,result FROM codex_login_reauthorizations WHERE operation_id=?',
      )
      .get(operation.operationId) as
      { conversation_id: string; original: string; result: string | null } | undefined;
  };
  const current = () => {
    operation.assertMutationCurrent();
    if (
      owner.hasRunningCommand() ||
      !isDeepStrictEqual(owner.custody(), operation.originalCustody())
    )
      throw Error('Original inactive host login custody required');
    owner.assertNoPendingThreadDispatch();
    owner.assertNoPendingThreadOwnership();
  };
  const already = read();
  if (already?.result) {
    operation.assertCurrent();
    if (
      already.conversation_id !== id ||
      !isDeepStrictEqual(owner.custody(), JSON.parse(already.result))
    )
      throw Error('Login reauthorization receipt changed');
    return { status: 'already_completed', operationId: operation.operationId };
  }
  current();
  db.exec(`CREATE TABLE IF NOT EXISTS codex_login_reauthorizations (
      operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, original TEXT NOT NULL,
      result TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    )`);
  db.transaction(() => {
    current();
    const previous = read();
    const original = JSON.stringify(operation.originalCustody());
    if (previous) {
      if (previous.conversation_id !== id || previous.original !== original || previous.result)
        throw Error('Login reauthorization intent changed');
    } else
      db.prepare('INSERT INTO codex_login_reauthorizations VALUES (?,?,?,?,?,NULL)').run(
        operation.operationId,
        id,
        original,
        null,
        Date.now(),
      );
  }).immediate();
  const result = operation.materialize();
  db.transaction(() => {
    current();
    const pending = read();
    if (
      !pending ||
      pending.result ||
      pending.original !== JSON.stringify(operation.originalCustody())
    )
      throw Error('Login reauthorization intent changed');
    const changed = db
      .prepare('UPDATE codex_conversations SET host_custody=? WHERE id=? AND host_custody=?')
      .run(JSON.stringify(result), id, pending.original).changes;
    if (changed !== 1) throw Error('Host login custody changed concurrently');
    db.prepare(
      'UPDATE codex_login_reauthorizations SET result=?,completed_at=? WHERE operation_id=? AND result IS NULL',
    ).run(JSON.stringify(result), Date.now(), operation.operationId);
  }).immediate();
  return { status: 'completed', operationId: operation.operationId };
}
