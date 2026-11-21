import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  SpecialistModelPolicySaveSchema,
  SpecialistModelPolicyVersionSchema,
} from '@mitzo/protocol';

/** Defaults live in the workspace events database. Only interactive operator
 * routes write settings; agents can read effective policy, never relax it. */
export class SpecialistModelPolicyStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS specialist_model_settings (
      scope TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specialist_model_settings_requests (
      request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
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
    return {
      admission: rule?.admission ?? 'ask',
      allowance: rule?.allowance ?? null,
      revision: `${view.workspace.revision}:${view.conversation.revision}`,
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
