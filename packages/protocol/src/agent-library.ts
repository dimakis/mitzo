import type { SymposiumProfileDefinition } from './symposium.js';
import { SymposiumProfileDefinitionSchema } from './symposium.js';
import { z } from 'zod';

export const AgentProfileSelectionSchema = z.strictObject({
  // Shared catalog IDs are opaque, bounded strings; names and IDs remain separate.
  profileId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
});
export type AgentProfileSelection = z.infer<typeof AgentProfileSelectionSchema>;
export const AgentLibraryVersionSchema = AgentProfileSelectionSchema.extend({
  definition: SymposiumProfileDefinitionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface AgentLibraryDraft {
  profileId: string;
  version: number;
  baseRevision: number;
  definition: SymposiumProfileDefinition;
}
export interface AgentLibraryVersion {
  profileId: string;
  revision: number;
  definition: SymposiumProfileDefinition;
  contentHash: string;
}
export interface AgentLibraryCatalog {
  drafts: AgentLibraryDraft[];
  versions: AgentLibraryVersion[];
}

export function agentProfileLabel(definition: SymposiumProfileDefinition): string {
  return definition.descriptor ? `${definition.name} · ${definition.descriptor}` : definition.name;
}
