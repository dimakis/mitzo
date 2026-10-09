export interface KnowledgeDocument {
  path: string;
  title: string;
  area: string;
}
export interface KnowledgeDraft {
  id: string;
  title: string;
  baseRevision: string;
  version: number;
  documents: { path: string; sourcePath?: string; base: string; content: string }[];
  directories?: string[];
  updatedAt: string;
  state: 'draft' | 'in-review' | 'accepted' | 'closed';
  review?: { url: string; head: string; version: number; ready?: boolean };
  error?: string;
  publication?: unknown;
}
export type KnowledgeDraftSummary = Omit<KnowledgeDraft, 'documents'> & {
  documents: { path: string }[];
};
export interface KnowledgeCatalog {
  revision: string;
  directories?: string[];
  documentPaths?: string[];
  documents: KnowledgeDocument[];
  drafts: KnowledgeDraftSummary[];
  reviewEnabled: boolean;
  acceptanceEnabled: boolean;
  syncedAt: string | null;
}
