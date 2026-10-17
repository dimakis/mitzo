import type { TodoOutput } from './todo';

/** Saved bytes remain distinct from delivery and optional Work associations. */
export interface SavedArtifactVersion extends TodoOutput {
  sessionId?: string;
  sourcePath?: string | null;
  createdAt?: string;
}
export interface SavedArtifactVersionPage {
  artifacts: SavedArtifactVersion[];
  cursor: number | null;
  hasMore: boolean;
}
export interface SavedArtifactDocument {
  path: string;
  name: string;
  ext: string;
  revision: number;
  content: string;
  previewUnavailable: boolean;
}
