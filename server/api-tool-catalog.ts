import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { z } from 'zod';
import { reviewedHandlerSourceArtifacts } from './connections/reviewed-handler-artifacts.js';
import type { AgentToolCatalogEntry, AgentToolReference } from '@mitzo/protocol';
import type { CredentialConnections } from './credential-connections.js';
import {
  apiToolBinding,
  apiToolConfigurationSchema,
  apiToolDefinition,
  apiToolRequest,
  apiToolTemplate,
  mapApiToolOutput,
  type ApiToolConfiguration,
} from './api-tool-template.js';

export const saveApiToolSchema = z.strictObject({
  id: z.uuid().regex(/^[0-9a-f-]+$/),
  expectedVersion: z.number().int().nonnegative(),
  configuration: apiToolConfigurationSchema,
});
interface Draft {
  id: string;
  version: number;
  configuration: ApiToolConfiguration;
  binding: string;
  verification: string | null;
}
interface Receipt {
  entry: AgentToolCatalogEntry & { revision: string };
  configuration: ApiToolConfiguration;
  binding: string;
  definition: ReturnType<typeof apiToolDefinition>;
  draftVersion: number;
}
export interface ApiToolVerificationOptions {
  service: CredentialConnections;
  signal: AbortSignal;
  assertCurrent(): void;
}
/** Private, single-host-owner publication store. Bodies, credentials and grants are never saved. */
export class ApiToolCatalog {
  private db: Database.Database;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS api_tool_drafts (id TEXT PRIMARY KEY, draft TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_tool_publications (id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL, PRIMARY KEY(id,version));`);
  }
  close() {
    this.closed = true;
    this.db.close();
  }
  drafts(): Draft[] {
    return (
      this.db.prepare('SELECT draft FROM api_tool_drafts ORDER BY rowid').all() as {
        draft: string;
      }[]
    ).map((r) => JSON.parse(r.draft));
  }
  private draft(id: string, version?: number): Draft {
    const row = this.db.prepare('SELECT draft FROM api_tool_drafts WHERE id=?').get(id) as
      { draft: string } | undefined;
    if (!row) throw Error('API tool draft not found');
    const draft: Draft = JSON.parse(row.draft);
    if (version !== undefined && draft.version !== version)
      throw Error('API tool draft version conflict');
    return draft;
  }
  private put(draft: Draft) {
    this.db
      .prepare('INSERT OR REPLACE INTO api_tool_drafts VALUES (?,?)')
      .run(draft.id, JSON.stringify(draft));
  }
  save(input: unknown, service: CredentialConnections): Draft {
    const { id, expectedVersion, configuration } = saveApiToolSchema.parse(input);
    const binding = apiToolBinding(configuration, service);
    return this.db
      .transaction(() => {
        const old = this.drafts().find((d) => d.id === id);
        if ((old?.version ?? 0) !== expectedVersion) {
          if (
            old?.version === expectedVersion + 1 &&
            old.binding === binding &&
            JSON.stringify(old.configuration) === JSON.stringify(configuration)
          )
            return old;
          throw Error('API tool draft version conflict');
        }
        const draft: Draft = {
          id,
          version: expectedVersion + 1,
          configuration,
          binding,
          verification: null,
        };
        this.put(draft);
        return draft;
      })
      .immediate();
  }
  async verify(id: string, version: number, options: ApiToolVerificationOptions) {
    const draft = this.draft(id, version);
    const generation = randomUUID();
    // Beginning a fresh verification invalidates prior proof, including failed or cancelled attempts.
    this.put({ ...draft, verification: generation });
    const check = () => {
      options.signal.throwIfAborted();
      options.assertCurrent();
      if (
        this.closed ||
        this.draft(id, version).verification !== generation ||
        apiToolBinding(draft.configuration, options.service) !== draft.binding
      )
        throw Error('API tool verification changed or unavailable');
    };
    const session = `api-tool-verification:${randomUUID()}`;
    try {
      check();
      const connection = options.service.connection(draft.configuration.connectionId);
      options.service.grant(session, connection.id, connection.revision);
      const response = await options.service.request(
        session,
        connection.id,
        apiToolRequest(draft.configuration),
        options.signal,
        () => {
          check();
          return true;
        },
      );
      check();
      mapApiToolOutput(draft.configuration, response);
      this.put({ ...draft, verification: `verified:${generation}` });
      return this.draft(id, version);
    } catch (error) {
      if (
        !this.closed &&
        this.drafts().some(
          (d) => d.id === id && d.version === version && d.verification === generation,
        )
      )
        this.put({ ...draft, verification: null });
      throw error;
    } finally {
      options.service.revokeSession(session, draft.configuration.connectionId);
    }
  }
  publish(id: string, version: number, service: CredentialConnections): Receipt['entry'] {
    return this.db
      .transaction(() => {
        const draft = this.draft(id, version);
        if (
          !draft.verification?.startsWith('verified:') ||
          apiToolBinding(draft.configuration, service) !== draft.binding
        )
          throw Error('API tool requires successful current verification');
        const previous = this.receipts().filter((r) => r.entry.id === `api:${id}`);
        const retry = previous.find((r) => r.draftVersion === version);
        if (retry) return retry.entry;
        const definition = apiToolDefinition(id, draft.configuration);
        const entry: Receipt['entry'] = {
          id: `api:${id}`,
          version: previous.length + 1,
          revision: randomUUID(),
          name: draft.configuration.label,
          description: apiToolTemplate.description,
          source: 'Reviewed API template',
          implementation: {
            template: apiToolTemplate.id,
            source: apiToolTemplate.source,
            fingerprint: reviewedHandlerSourceArtifacts['../api-tool-template.ts'],
          },
          required: false,
          behavior: 'read',
          routes: ['local-api', 'codex'],
          requirement:
            'Reviewed read-only API template. Select RequestConnectionAccess too; current connection approval is required. New session required for changes.',
        };
        const receipt: Receipt = {
          entry,
          configuration: draft.configuration,
          binding: draft.binding,
          definition,
          draftVersion: version,
        };
        this.db
          .prepare('INSERT INTO api_tool_publications VALUES (?,?,?,?)')
          .run(entry.id, entry.version, entry.revision, JSON.stringify(receipt));
        return entry;
      })
      .immediate();
  }
  private receipts(): Receipt[] {
    return (
      this.db.prepare('SELECT receipt FROM api_tool_publications ORDER BY rowid').all() as {
        receipt: string;
      }[]
    ).map((r) => JSON.parse(r.receipt));
  }
  list(): Receipt['entry'][] {
    return [...new Map(this.receipts().map((r) => [r.entry.id, r.entry])).values()];
  }
  reference(entry: Receipt['entry']): AgentToolReference {
    return { id: entry.id, version: entry.version, revision: entry.revision };
  }
  resolve(ref: AgentToolReference, service: CredentialConnections): Receipt {
    const receipt = this.receipts().find(
      (r) =>
        r.entry.id === ref.id &&
        r.entry.version === ref.version &&
        'revision' in ref &&
        r.entry.revision === ref.revision,
    );
    if (!receipt) throw Error('API tool reference is unresolved on this installation');
    const draft = this.draft(receipt.entry.id.slice(4));
    if (
      draft.version !== receipt.draftVersion ||
      !draft.verification?.startsWith('verified:') ||
      apiToolBinding(receipt.configuration, service) !== receipt.binding
    )
      throw Error(
        'API tool configuration changed or verification unavailable; verify and publish again, then start a new session',
      );
    return structuredClone(receipt);
  }
}
