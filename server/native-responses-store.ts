import Database from 'better-sqlite3';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import type { ConversationMessage, ResponsesCheckpoint } from '@mitzo/harness';

export interface NativeResponsesState {
  status: 'running' | 'idle' | 'interrupted';
  checkpoint?: ResponsesCheckpoint;
  history: ConversationMessage[];
}

/** Server-only continuation storage, deliberately separate from public transcript metadata.
 * One server process owns this database. Call recoverAtStartup only before accepting work.
 */
export class NativeResponsesStore {
  private db: Database.Database;
  constructor(path: string) {
    // Create privately before SQLite opens it (including its rollback journal).
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS native_responses (conversation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL)',
    );
  }
  private bindingKey(binding: AccountBinding) {
    return JSON.stringify([
      binding.accountId,
      binding.provider,
      binding.model,
      binding.profileRevision,
    ]);
  }
  load(conversationId: string, binding: AccountBinding): NativeResponsesState | undefined {
    const row = this.db
      .prepare('SELECT binding, state FROM native_responses WHERE conversation_id = ?')
      .get(conversationId) as { binding: string; state: string } | undefined;
    if (!row) return undefined;
    if (row.binding !== this.bindingKey(binding))
      throw new Error('Native Responses account/model binding changed');
    return JSON.parse(row.state) as NativeResponsesState;
  }
  begin(conversationId: string, binding: AccountBinding): NativeResponsesState {
    return this.db.transaction(() => {
      const state = this.load(conversationId, binding) ?? { status: 'idle', history: [] };
      if (state.status === 'running')
        throw new Error('Native Responses conversation already running');
      state.status = 'running';
      this.save(conversationId, binding, state);
      return state;
    })();
  }
  save(conversationId: string, binding: AccountBinding, state: NativeResponsesState) {
    // Explicit fields only: credentials and runner configuration are never serialized.
    const checkpoint =
      state.checkpoint &&
      ({
        accountId: state.checkpoint.accountId,
        model: state.checkpoint.model,
        history: state.checkpoint.history,
        input: state.checkpoint.input,
      } satisfies Record<keyof ResponsesCheckpoint, unknown>);
    const result = this.db
      .prepare(
        'INSERT INTO native_responses VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET state = excluded.state WHERE native_responses.binding = excluded.binding',
      )
      .run(
        conversationId,
        this.bindingKey(binding),
        JSON.stringify({ status: state.status, history: state.history, checkpoint }),
      );
    if (result.changes !== 1) throw new Error('Native Responses account/model binding changed');
  }
  recoverAtStartup() {
    this.db.exec(
      "UPDATE native_responses SET state = json_set(state, '$.status', 'interrupted') WHERE json_extract(state, '$.status') = 'running'",
    );
  }
  close() {
    this.db.close();
  }
}
