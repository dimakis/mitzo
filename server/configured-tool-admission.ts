import { isDeepStrictEqual } from 'node:util';
import type { AgentToolReference } from '@mitzo/protocol';
import { connectCodexMcpTools, mcpWireName, mcpToolOutputScope } from './codex-mcp-tools.js';
import { ConfiguredToolCatalog, type ConfiguredCatalogOptions } from './configured-tool-catalog.js';
import { snapshotMcpEnvironment } from './mcp-launch-environment.js';
import { LazyMcpSource } from './lazy-mcp-source.js';
import { createLogger } from './logger.js';

/** Publish pinned catalog definitions without launching any source. Live schemas are
 * verified on first use, before the existing permission and execution path. */
export async function admitConfiguredTools(
  catalog: ConfiguredToolCatalog,
  refs: AgentToolReference[],
  options: ConfiguredCatalogOptions,
) {
  const selected = refs.filter((ref) => ref.id.startsWith('mcp:'));
  options.assertRuntimeCurrent();
  options.signal.throwIfAborted();
  const sourceSnapshot = structuredClone(options.readSources());
  const launchOptions = {
    ...options,
    env: snapshotMcpEnvironment(options.env),
    readSources: () => sourceSnapshot,
  };
  const receipts = selected.map((ref) => catalog.resolve(ref, launchOptions));
  let closed = false;
  const assertCurrent = () => {
    options.signal.throwIfAborted();
    if (closed) throw Error('Configured MCP tools closed');
    options.assertRuntimeCurrent();
    for (const ref of selected) catalog.resolve(ref, options);
  };
  assertCurrent();
  const admitted = receipts.map((receipt) => ({
    wireName: mcpWireName(JSON.stringify([receipt.sourceId, receipt.tool])),
    reference: catalog.reference(receipt.entry),
    sourceId: receipt.sourceId,
    tool: receipt.tool,
  }));
  const names = new Map(admitted.map((entry, index) => [entry.wireName, index]));
  if (names.size !== admitted.length) throw Error('Duplicate selected MCP tool identity');
  const sources = new Map<
    string,
    LazyMcpSource<Awaited<ReturnType<typeof connectConfiguredTools>>>
  >();
  for (const sourceId of new Set(receipts.map((receipt) => receipt.sourceId))) {
    sources.set(
      sourceId,
      new LazyMcpSource(sourceId, (signal) =>
        connectConfiguredTools(
          catalog,
          admitted.filter((entry) => entry.sourceId === sourceId).map((entry) => entry.reference),
          {
            ...launchOptions,
            signal: AbortSignal.any([signal, options.signal]),
            assertRuntimeCurrent: assertCurrent,
          },
        ),
      ),
    );
  }
  const indexOf = (name: string) => {
    assertCurrent();
    const index = names.get(name);
    if (index === undefined) throw Error('Configured tool is not selected');
    return index;
  };
  const definitions = admitted.map((entry, index) => ({
    ...receipts[index].definition,
    name: entry.wireName,
    description: `Configured source ${entry.sourceId}, ${entry.tool}: ${receipts[index].definition.description}`,
  }));
  const outputScopes = receipts.map((receipt) =>
    mcpToolOutputScope(
      Object.values(sourceSnapshot).find((config) => config.librarySourceId === receipt.sourceId)!,
      { ...launchOptions, cwd: receipt.launchCwd },
      receipt.descriptor,
    ),
  );
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    closing = (async () => {
      const results = await Promise.allSettled(
        [...sources.values()].map((source) => source.close()),
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length) {
        createLogger('configured-mcp').warn('MCP source cleanup failed', {
          code: 'mcp_cleanup_failed',
          stage: 'cleanup',
          count: failures.length,
        });
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Configured MCP cleanup failed',
        );
      }
    })();
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => {
      /* close reports failures; explicit close retains the rejected receipt. */
    });
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  const ensureToolCurrent = async (name: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const index = indexOf(name);
    const peer = await sources
      .get(receipts[index].sourceId)!
      .get(AbortSignal.any([signal, options.signal]));
    indexOf(name);
    peer.assertToolCurrent(name);
    return peer;
  };
  return {
    definitions,
    admitted,
    close,
    ensureToolCurrent: async (name: string, signal: AbortSignal) => {
      await ensureToolCurrent(name, signal);
    },
    displayName: (name: string) => {
      const index = names.get(name);
      if (index === undefined) return name;
      const receipt = receipts[index];
      const source = Object.entries(sourceSnapshot).find(
        ([, config]) => config.librarySourceId === receipt.sourceId,
      )![0];
      return `mcp__${source}__${receipt.tool}`;
    },
    assertToolCurrent: (name: string) => {
      indexOf(name);
    },
    outputScope: (name: string) => outputScopes[indexOf(name)],
    execute: async (
      ...args: Parameters<Awaited<ReturnType<typeof connectCodexMcpTools>>['execute']>
    ) => {
      const peer = await ensureToolCurrent(args[0], args[3]);
      return peer.execute(...args);
    },
  };
}

/** Resolves receipts before starting peers; only selected sources are ever started. */
async function connectConfiguredTools(
  catalog: ConfiguredToolCatalog,
  refs: AgentToolReference[],
  options: ConfiguredCatalogOptions,
) {
  const selected = refs.filter((ref) => ref.id.startsWith('mcp:'));
  options.assertRuntimeCurrent();
  options.signal.throwIfAborted();
  const sourceSnapshot = structuredClone(options.readSources());
  const launchOptions = {
    ...options,
    env: snapshotMcpEnvironment(options.env),
    readSources: () => sourceSnapshot,
  };
  const receipts = selected.map((ref) => catalog.resolve(ref, launchOptions));
  const sourceIds = new Set(receipts.map((receipt) => receipt.sourceId));
  const sources = Object.fromEntries(
    Object.entries(sourceSnapshot).filter(([, config]) =>
      sourceIds.has(config.librarySourceId ?? ''),
    ),
  );
  const assertCurrent = () => {
    options.assertRuntimeCurrent();
    for (const ref of selected) catalog.resolve(ref, options);
  };
  const peers = await connectCodexMcpTools(sources, {
    ...launchOptions,
    cwdForSource: (server) =>
      receipts.find((receipt) => receipt.sourceId === sources[server].librarySourceId)!.launchCwd,
    assertRuntimeCurrent: assertCurrent,
  });
  try {
    assertCurrent();
    const admitted = receipts.map((receipt) => {
      const source = Object.entries(sources).find(
        ([, config]) => config.librarySourceId === receipt.sourceId,
      )![0];
      const tool = peers.discovered.find(
        (tool) => tool.server === source && tool.tool === receipt.tool,
      );
      const descriptionPrefix = `mcp__${source}__${receipt.tool}: `;
      if (
        !tool ||
        !isDeepStrictEqual(tool.descriptor, receipt.descriptor) ||
        !isDeepStrictEqual(
          {
            ...tool.definition,
            name: receipt.tool,
            description: tool.definition.description.slice(descriptionPrefix.length),
          },
          receipt.definition,
        )
      )
        throw Error(
          'Selected configured tool definition changed or was removed; new discovery and session required',
        );
      return {
        wireName: tool.definition.name,
        reference: catalog.reference(receipt.entry),
        sourceId: receipt.sourceId,
        tool: receipt.tool,
      };
    });
    const names = new Set(admitted.map((entry) => entry.wireName));
    return {
      ...peers,
      definitions: admitted.map((entry) => {
        const receipt = receipts.find((receipt) => receipt.entry.id === entry.reference.id)!;
        return {
          ...receipt.definition,
          name: entry.wireName,
          description: `Configured source ${receipt.sourceId}, ${receipt.tool}: ${receipt.definition.description}`,
        };
      }),
      admitted,
      outputScope: (name: string) => {
        if (!names.has(name)) throw Error('Configured tool is not selected');
        assertCurrent();
        return peers.outputScope(name);
      },
      assertToolCurrent: (name: string) => {
        if (!names.has(name)) throw Error('Configured tool is not selected');
        assertCurrent();
        peers.assertToolCurrent(name);
      },
      execute: (...args: Parameters<typeof peers.execute>) => {
        if (!names.has(args[0])) throw Error('Configured tool is not selected');
        assertCurrent();
        return peers.execute(...args);
      },
    };
  } catch (error) {
    try {
      await peers.close();
    } catch (cleanupError) {
      createLogger('configured-mcp').warn('MCP cleanup failed after schema validation', {
        code: 'mcp_cleanup_failed',
        stage: 'schema_validation',
      });
      throw new AggregateError([cleanupError], 'MCP schema validation and cleanup failed', {
        // eslint-disable-next-line preserve-caught-error -- Keep the primary cause and retain cleanup separately in errors.
        cause: error,
      });
    }
    throw error;
  }
}
