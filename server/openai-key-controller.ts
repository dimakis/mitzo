import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Disabling all Connections must not bypass a previously enrolled account's durable fence. */
export function assertOpenAIKeyController(
  accountId: string,
  directory: string,
  available: boolean,
) {
  if (available) return;
  const path = join(directory, 'openai-key-operations.db');
  if (!existsSync(path)) return;
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    if (
      !database
        .prepare('SELECT 1 FROM openai_key_operations WHERE accountId=? LIMIT 1')
        .get(accountId)
    )
      return;
  } catch {
    // Unknown ownership in a damaged journal cannot authorize an API request.
  } finally {
    database?.close();
  }
  throw new Error('OpenAI credential management must be restored before continuing this account');
}
