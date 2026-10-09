import type { SymposiumProfileDefinition } from './symposium.js';

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
