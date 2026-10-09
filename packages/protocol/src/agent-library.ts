import type { SymposiumProfileDefinition } from './symposium.js';
import { SymposiumProfileDefinitionSchema } from './symposium.js';
import { z } from 'zod';

export const AgentProfileSelectionSchema = z.strictObject({
  profileId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
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
