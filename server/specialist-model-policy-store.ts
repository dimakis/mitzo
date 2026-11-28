import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  SpecialistModelPolicySaveSchema,
  SpecialistModelPolicyVersionSchema,
} from '@mitzo/protocol';

/** Defaults live in the workspace events database. Only interactive operator
 * routes write settings; agents can read effective policy, never relax it. */
export class SpecialistModelPolicyStore {
  private readonly db: Database.Database;
  private readonly ownsDatabase: boolean;
  constructor(path: string | Database.Database) {
    this.ownsDatabase = typeof path === 'string';
    this.db = typeof path === 'string' ? new Database(path) : path;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS specialist_model_settings (
      scope TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specialist_model_settings_requests (
      request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  close() {
    if (this.ownsDatabase) this.db.close();
  }
  read(scope: string) {
    const row = this.db
      .prepare('SELECT body FROM specialist_model_settings WHERE scope=?')
      .get(scope) as { body: string } | undefined;
    return SpecialistModelPolicyVersionSchema.parse(
      row ? JSON.parse(row.body) : { revision: 0, policy: null },
    );
  }
  view(conversation: string) {
    return { workspace: this.read('workspace'), conversation: this.read(conversation) };
  }
  resolve(conversation: string, accountId: string, model: string) {
    const view = this.view(conversation);
    const effective = view.conversation.policy ?? view.workspace.policy;
    const rule = effective?.models.find(
      (entry) => entry.accountId === accountId && entry.model === model,
    );
    const admission = rule?.admission ?? 'ask';
    const allowance = rule?.allowance ?? null;
    return {
      admission,
      allowance,
      // Fingerprint only this route's effective rule. Admitted work is fenced
      // on its own admission/allowance; unrelated edits (another model, another
      // conversation, or a workspace change this conversation overrides)
      // apply to future admissions only.
      revision: `rule:${createHash('sha256')
        .update(JSON.stringify([admission, allowance]))
        .digest('hex')
        .slice(0, 16)}`,
    };
  }
  save(scope: string, raw: unknown) {
    const input = SpecialistModelPolicySaveSchema.parse(raw);
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare(
            'SELECT scope, input, result FROM specialist_model_settings_requests WHERE request_id=?',
          )
          .get(input.requestId) as { scope: string; input: string; result: string } | undefined;
        if (previous) {
          if (previous.scope !== scope || !isDeepStrictEqual(JSON.parse(previous.input), input))
            throw Error('Model policy request conflict');
          return SpecialistModelPolicyVersionSchema.parse(JSON.parse(previous.result));
        }
        const current = this.read(scope);
        if (current.revision !== input.expectedRevision)
          throw Error('Model policy revision conflict');
        const result = { revision: current.revision + 1, policy: input.policy };
        this.db
          .prepare(
            'INSERT INTO specialist_model_settings VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET body=excluded.body',
          )
          .run(scope, JSON.stringify(result));
        this.db
          .prepare('INSERT INTO specialist_model_settings_requests VALUES(?,?,?,?)')
          .run(input.requestId, scope, JSON.stringify(input), JSON.stringify(result));
        return result;
      })
      .immediate();
  }
}
