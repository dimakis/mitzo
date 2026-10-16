import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { AgentToolCatalogEntry, AgentToolReference } from '@mitzo/protocol';
import type { ToolDefinition } from '@mitzo/harness';
import { connectCodexMcpTools, type McpToolsOptions } from './codex-mcp-tools.js';
import type { McpServerConfig } from './mcp-config.js';

type Sources = Record<string, McpServerConfig>;
export interface ConfiguredCatalogOptions extends McpToolsOptions {
  /** Server-owned configuration getter: never supplied by the picker or profile. */
  readSources(): Sources;
  assertRuntimeCurrent: () => void;
}
export type ConfiguredToolCatalogEntry = AgentToolCatalogEntry & { revision: string };
interface Receipt {
  entry: ConfiguredToolCatalogEntry;
  sourceId: string;
  tool: string;
  binding: string;
  launchCwd: string;
  definition: ToolDefinition;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function eligible(sources: Sources): Sources {
  const result: Sources = {};
  const seen = new Set<string>();
  for (const [name, config] of Object.entries(sources)) {
    if (!config.librarySourceId || config.execution === 'sandbox') continue;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.librarySourceId)
    )
      throw Error('Invalid configured source identity');
    if (seen.has(config.librarySourceId)) throw Error('Duplicate configured source identity');
    seen.add(config.librarySourceId);
    if (seen.size > 64) throw Error('Configured source limit exceeded');
    result[name] = config;
  }
  return result;
}
function binding(config: McpServerConfig, options: Pick<McpToolsOptions, 'cwd' | 'env'>): string {
  // Private only. Labels and source identity are excluded; actual launch inputs are pinned.
  const launch = {
    type: config.type,
    command: config.command,
    args: config.args,
    env: config.env,
    execution: config.execution,
  };
  return hash({ config: launch, cwd: options.cwd, env: options.env });
}
/** Durable discovery receipts. Read projections never start a peer. One host owner per database. */
export class ConfiguredToolCatalog {
  private db: Database.Database;
  private generation = 0;
  private closed = false;
  constructor(path: string) {
    if (path !== ':memory:') {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS configured_tools (id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL UNIQUE, active INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(id,version))',
    );
  }
  close(): void {
    this.closed = true;
    ++this.generation;
    this.db.close();
  }
  reference(entry: AgentToolCatalogEntry): AgentToolReference {
    if (!('revision' in entry)) throw Error('Configured revision unavailable');
    return { id: entry.id, version: entry.version, revision: entry.revision };
  }
  list(): ConfiguredToolCatalogEntry[] {
    return (
      this.db
        .prepare('SELECT receipt FROM configured_tools WHERE active=1 ORDER BY rowid')
        .all() as { receipt: string }[]
    ).map((row) => JSON.parse(row.receipt).entry);
  }
  private receipt(ref: AgentToolReference): Receipt {
    const row = this.db
      .prepare(
        'SELECT active,receipt FROM configured_tools WHERE id=? AND version=? AND revision=?',
      )
      .get(ref.id, ref.version, 'revision' in ref ? ref.revision : '') as
      { active: number; receipt: string } | undefined;
    if (!row) throw Error('Configured tool reference is unresolved on this installation');
    if (!row.active)
      throw Error('Selected configured tool is unavailable or changed; new session required');
    return JSON.parse(row.receipt);
  }
  resolve(ref: AgentToolReference, options: ConfiguredCatalogOptions): Receipt & { name: string } {
    options.assertRuntimeCurrent();
    options.signal.throwIfAborted();
    const receipt = this.receipt(ref);
    const source = Object.values(eligible(options.readSources())).find(
      (config) => config.librarySourceId === receipt.sourceId,
    );
    if (!source) throw Error('Selected configured source is unavailable or no longer configured');
    if (binding(source, { ...options, cwd: receipt.launchCwd }) !== receipt.binding)
      throw Error('Selected source configuration changed; new discovery and session required');
    return { ...structuredClone(receipt), name: receipt.tool };
  }
  async refresh(options: ConfiguredCatalogOptions): Promise<ConfiguredToolCatalogEntry[]> {
    if (!options.assertRuntimeCurrent) throw Error('Discovery requires runtime custody authority');
    const generation = ++this.generation;
    const sources = structuredClone(eligible(options.readSources()));
    const initial = hash(sources);
    const assertCurrent = () => {
      if (this.closed || generation !== this.generation)
        throw Error('Discovery superseded or cancelled');
      options.signal.throwIfAborted();
      options.assertRuntimeCurrent();
      if (hash(eligible(options.readSources())) !== initial)
        throw Error('Configured sources changed during discovery');
    };
    assertCurrent();
    let clients;
    try {
      clients = await connectCodexMcpTools(sources, {
        ...options,
        assertRuntimeCurrent: assertCurrent,
      });
      assertCurrent();
      this.db
        .transaction(() => {
          const previous = new Map(this.list().map((entry) => [entry.id, this.receipt(entry)]));
          this.db.prepare('UPDATE configured_tools SET active=0').run();
          for (const tool of clients!.discovered) {
            const source = sources[tool.server];
            const id = `mcp:${source.librarySourceId}:${createHash('sha256').update(tool.tool).digest('hex')}`;
            // Wire aliases embed mutable labels; pin the original definition independently.
            const definition = {
              ...tool.definition,
              name: tool.tool,
              description: tool.definition.description.slice(
                `mcp__${tool.server}__${tool.tool}: `.length,
              ),
            };
            const contract = binding(source, options);
            const old = previous.get(id);
            if (
              old &&
              old.binding === contract &&
              canonical(old.definition) === canonical(definition)
            ) {
              // A friendly rename changes the projection only, never the portable contract.
              old.entry.source = tool.server;
              this.db
                .prepare('UPDATE configured_tools SET active=1,receipt=? WHERE revision=?')
                .run(JSON.stringify(old), old.entry.revision);
              continue;
            }
            const max = this.db
              .prepare('SELECT MAX(version) AS version FROM configured_tools WHERE id=?')
              .get(id) as { version: number | null };
            const entry: Receipt['entry'] = {
              id,
              version: (max.version ?? 0) + 1,
              revision: randomUUID(),
              name: tool.tool,
              description: definition.description,
              source: tool.server,
              required: false,
              behavior: 'mixed',
              routes: [],
              requirement:
                'Configured stdio discovery receipt. Selection enrollment pending; new session required.',
            };
            const receipt: Receipt = {
              entry,
              sourceId: source.librarySourceId!,
              tool: tool.tool,
              binding: contract,
              launchCwd: options.cwd,
              definition,
            };
            this.db
              .prepare('INSERT INTO configured_tools VALUES (?,?,?,?,?)')
              .run(id, entry.version, entry.revision, 1, JSON.stringify(receipt));
          }
        })
        .immediate();
      return this.list();
    } catch (error) {
      if (generation !== this.generation || this.closed)
        throw Error('Discovery superseded or cancelled', { cause: error });
      throw error;
    } finally {
      await clients?.close();
    }
  }
}
