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
    // New files are created with 0600 atomically; chmod also tightens existing files.
    // The enclosing directory must be private, as required by the integration contract.
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
    const state = JSON.parse(row.state) as NativeResponsesState & {
      checkpoint?: ResponsesCheckpoint & { historyLength?: number };
    };
    if (state.checkpoint && state.checkpoint.historyLength !== undefined) {
      state.checkpoint.history = structuredClone(
        state.history.slice(0, state.checkpoint.historyLength),
      );
      delete state.checkpoint.historyLength;
    }
    return state;
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
    const checkpoint = state.checkpoint && {
      accountId: state.checkpoint.accountId,
      model: state.checkpoint.model,
      // Persist only the prefix boundary; the history itself already exists at state level.
      historyLength: state.checkpoint.history.length,
      input: state.checkpoint.input,
    };
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
