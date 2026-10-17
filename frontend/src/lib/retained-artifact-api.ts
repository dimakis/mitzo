import { z } from 'zod';
import { apiFetch } from './api-fetch';
import type {
  SavedArtifactDocument,
  SavedArtifactVersion,
  SavedArtifactVersionPage,
} from '../types/retained-artifact';

const revision = z.number().int().positive().safe();
const version = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  itemId: z.string().min(1),
  filename: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  revision,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().safe(),
  url: z.string(),
  sessionId: z.string().optional(),
  sourcePath: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  sourceKind: z
    .enum([
      'user_upload',
      'user_edit',
      'session_artifact',
      'external_codex_report',
      'source_capture',
    ])
    .optional(),
});
export function savedArtifactUrl(value: Pick<SavedArtifactVersion, 'id' | 'revision'>) {
  const id = version.shape.id.parse(value.id);
  return `/api/telos/artifacts/${id}?revision=${revision.parse(value.revision)}`;
}
async function readJson(url: string, signal: AbortSignal) {
  const response = await apiFetch(url, { signal });
  if (!response.ok)
    throw Error(
      response.status === 403
        ? 'This saved artifact is no longer available to you.'
        : 'Unable to load this saved artifact.',
    );
  return response.json() as Promise<unknown>;
}
export async function readSavedArtifactVersions(
  artifact: Pick<SavedArtifactVersion, 'id' | 'itemId'>,
  signal: AbortSignal,
  beforeRevision?: number,
): Promise<SavedArtifactVersionPage> {
  const id = version.shape.id.parse(artifact.id);
  const page = z
    .object({
      artifacts: z.array(version).max(50),
      cursor: revision.nullable(),
      hasMore: z.boolean(),
    })
    .parse(
      await readJson(
        `/api/telos/artifacts/${id}/versions${beforeRevision === undefined ? '' : `?beforeRevision=${revision.parse(beforeRevision)}`}`,
        signal,
      ),
    );
  if (
    page.hasMore !== (page.cursor !== null) ||
    (page.hasMore && page.cursor !== page.artifacts.at(-1)?.revision)
  )
    throw Error('Saved version history changed. Retry the history.');
  let previous = beforeRevision ?? Number.MAX_SAFE_INTEGER;
  for (const row of page.artifacts) {
    if (
      row.id !== artifact.id ||
      row.itemId !== artifact.itemId ||
      row.revision >= previous ||
      row.url !== savedArtifactUrl(row) ||
      row.sourceKind === 'source_capture'
    )
      throw Error('Saved version history changed. Retry the history.');
    previous = row.revision;
  }
  return page;
}
export async function readSavedArtifactDocument(
  artifact: SavedArtifactVersion,
  signal: AbortSignal,
): Promise<SavedArtifactDocument> {
  const url = savedArtifactUrl(artifact);
  const data = z
    .object({
      path: z.string(),
      name: z.string(),
      ext: z.string(),
      revision,
      content: z.string(),
      previewUnavailable: z.boolean(),
      editable: z.boolean().default(false),
    })
    .parse(
      await readJson(
        `/api/telos/artifacts/${artifact.id}/document?revision=${artifact.revision}`,
        signal,
      ),
    );
  if (data.revision !== artifact.revision || data.path !== url || data.name !== artifact.filename)
    throw Error('The preview does not match the selected saved version. Retry this version.');
  return data;
}

export async function readSavedArtifactVersion(
  artifact: Pick<SavedArtifactVersion, 'id' | 'itemId'>,
  pin: { revision: number; sha256: string },
  signal: AbortSignal,
): Promise<SavedArtifactVersion> {
  const selected = revision.parse(pin.revision);
  const page = await readSavedArtifactVersions(
    artifact,
    signal,
    selected === Number.MAX_SAFE_INTEGER ? undefined : selected + 1,
  );
  const exact = page.artifacts.find((row) => row.revision === selected);
  if (!exact || exact.sha256 !== pin.sha256)
    throw Error('The selected saved version is unavailable or changed.');
  return exact;
}
