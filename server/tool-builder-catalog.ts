import type { AgentToolCatalogEntry } from '@mitzo/protocol';
import { agentToolCatalog, readAgentToolContract } from './agent-tool-catalog.js';
import { apiToolTemplate } from './api-tool-template.js';
import type { ApiToolOwner } from './api-tool-router.js';
import type { ConfiguredCatalogOptions, ConfiguredToolCatalog } from './configured-tool-catalog.js';
import type { ToolBuilderCatalog } from './tool-builder.js';
import type { ToolBuilderStore } from './tool-builder-store.js';
import {
  ToolBuilderContractReferenceSchema,
  type ToolBuilderContractReference,
} from './tool-builder-tool-definitions.js';

export interface ToolBuilderCatalogReader extends ToolBuilderCatalog {
  readContract(reference: ToolBuilderContractReference): Promise<unknown>;
}
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const reference = (entry: AgentToolCatalogEntry) =>
  ToolBuilderContractReferenceSchema.parse({
    id: entry.id,
    version: entry.version,
    ...('revision' in entry ? { revision: entry.revision } : {}),
  });
export function createToolBuilderCatalog(options: {
  store: ToolBuilderStore;
  api?: ApiToolOwner;
  configured?: { catalog: ConfiguredToolCatalog; options: ConfiguredCatalogOptions };
}): ToolBuilderCatalogReader {
  const entries = () => [
    ...agentToolCatalog(),
    ...(options.configured?.catalog.list() ?? []),
    ...(options.api?.catalog.list() ?? []),
    ...options.store.listTools('user'),
  ];
  return {
    async search(query) {
      const wanted = normalize(query);
      const words = wanted.split(' ').filter((word) => word.length > 2);
      const candidates = [
        ...entries().map((entry) => ({
          ...entry,
          reference: reference(entry),
          kind: 'tool' as const,
        })),
        {
          id: `template:${apiToolTemplate.id}`,
          version: 1,
          name: apiToolTemplate.label,
          description: apiToolTemplate.description,
          reference: { id: `template:${apiToolTemplate.id}`, version: 1 },
          kind: 'reviewed-template' as const,
        },
      ];
      return candidates
        .map((entry) => {
          const text = normalize(`${entry.name} ${entry.description}`);
          const rank = words.filter((word) => text.split(' ').includes(word)).length;
          // Token overlap ranks candidates only. Equivalence needs an exact known
          // identity/description or an explicit agent recommendation after reading.
          const equivalent =
            entry.kind === 'tool' &&
            [entry.id, entry.name, entry.description].some((value) => normalize(value) === wanted);
          return { ...entry, equivalent, rank };
        })
        .filter((entry) => entry.equivalent || entry.rank > 0)
        .sort(
          (a, b) =>
            Number(b.equivalent) - Number(a.equivalent) ||
            b.rank - a.rank ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 30);
    },
    async readContract(raw) {
      const selected = ToolBuilderContractReferenceSchema.parse(raw);
      if (selected.id === `template:${apiToolTemplate.id}`)
        return { kind: 'reviewed-template', reference: selected, template: apiToolTemplate };
      const entry = entries().find(
        (entry) => JSON.stringify(reference(entry)) === JSON.stringify(selected),
      );
      if (!entry) throw Error('Exact installed tool reference was not found');
      if (selected.id.startsWith('mitzo:'))
        return { entry, definition: readAgentToolContract(selected.id, selected.version) };
      if (selected.id.startsWith('mcp:')) {
        if (!options.configured) throw Error('Configured source contract is unavailable');
        return {
          entry,
          definition: options.configured.catalog.resolve(selected, options.configured.options)
            .definition,
        };
      }
      if (selected.id.startsWith('api:')) {
        if (!options.api) throw Error('API contract owner is unavailable');
        return {
          entry,
          definition: options.api.catalog.resolve(selected, options.api.service).definition,
        };
      }
      const publication = options.store.resolve('user', selected);
      const record = options.store.read('user', selected.id.slice(7), selected.version)!;
      return {
        entry,
        definition: publication.binding.definition,
        outputSchema: record.draft.outputSchema,
        permissions: record.draft.permissions,
      };
    },
  };
}
