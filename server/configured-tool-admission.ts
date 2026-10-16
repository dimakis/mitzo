import { isDeepStrictEqual } from 'node:util';
import type { AgentToolReference } from '@mitzo/protocol';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { ConfiguredToolCatalog, type ConfiguredCatalogOptions } from './configured-tool-catalog.js';

/** Resolves receipts before starting peers; only selected sources are ever started. */
export async function admitConfiguredTools(
  catalog: ConfiguredToolCatalog,
  refs: AgentToolReference[],
  options: ConfiguredCatalogOptions,
) {
  const selected = refs.filter((ref) => ref.id.startsWith('mcp:'));
  const receipts = selected.map((ref) => catalog.resolve(ref, options));
  const sourceIds = new Set(receipts.map((receipt) => receipt.sourceId));
  const sources = Object.fromEntries(
    Object.entries(options.readSources()).filter(([, config]) =>
      sourceIds.has(config.librarySourceId ?? ''),
    ),
  );
  const assertCurrent = () => {
    options.assertRuntimeCurrent();
    for (const ref of selected) catalog.resolve(ref, options);
  };
  const peers = await connectCodexMcpTools(sources, {
    ...options,
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
      execute: (...args: Parameters<typeof peers.execute>) => {
        if (!names.has(args[0])) throw Error('Configured tool is not selected');
        assertCurrent();
        return peers.execute(...args);
      },
    };
  } catch (error) {
    await peers.close();
    throw error;
  }
}
