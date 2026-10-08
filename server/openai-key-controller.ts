import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasOtherOpenAIKeyResourceOwner,
  type OpenAIKeyResourceBindings,
} from './openai-key-operation-store.js';

/** Disabling all Connections must not bypass a previously enrolled account's durable fence. */
export function assertOpenAIKeyController(
  accountId: string,
  directory: string,
  available: boolean,
  resources?: OpenAIKeyResourceBindings,
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
        .get(accountId) &&
      !(resources && hasOtherOpenAIKeyResourceOwner(database, accountId, resources))
    )
      return;
  } catch {
    // Unknown ownership in a damaged journal cannot authorize an API request.
  } finally {
    database?.close();
  }
  throw new Error('OpenAI credential management must be restored before continuing this account');
}
