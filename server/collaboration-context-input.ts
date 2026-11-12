import { createHash } from 'node:crypto';
import { CollaborationContractError, type CollaborationSnapshot } from '@mitzo/protocol';

export function snapshotMaterial(
  snapshot: Pick<
    CollaborationSnapshot,
    | 'sourceConversationId'
    | 'boundary'
    | 'purpose'
    | 'joiningBrief'
    | 'messages'
    | 'artifacts'
    | 'summary'
  >,
) {
  return {
    sourceConversationId: snapshot.sourceConversationId,
    boundary: snapshot.boundary,
    purpose: snapshot.purpose,
    joiningBrief: snapshot.joiningBrief,
    messages: snapshot.messages,
    artifacts: snapshot.artifacts,
    summary: snapshot.summary,
  };
}
type TextArtifact = Pick<
  CollaborationSnapshot['artifacts'][number],
  'sha256' | 'mediaType' | 'sizeBytes' | 'contentBase64'
> & { filename?: string };
/** The existing Local Codex text adapter consumes exact UTF-8 content. Opaque
 * bytes, absent historical content and unsupported files must never become a
 * note-only delivery or an instruction to fetch a private host path. */
export function collaborationArtifactText(artifact: TextArtifact) {
  const unavailable = () =>
    new CollaborationContractError(
      'execution_unavailable',
      'This artifact format cannot be delivered as ordinary text. Choose a supported saved text version.',
    );
  const textFormat =
    /^text\/(?:plain|markdown|csv|html|css|javascript|typescript|x-diff|x-python)(?:;\s*charset=utf-8)?$/i.test(
      artifact.mediaType,
    ) ||
    artifact.mediaType === 'application/json' ||
    (artifact.mediaType === 'application/octet-stream' &&
      /\.(?:txt|md|json|jsonl|yaml|yml|toml|xml|html|css|csv|diff|patch|py|js|jsx|ts|tsx|rs|go|sh|sql)$/i.test(
        artifact.filename ?? '',
      ));
  if (!textFormat || artifact.contentBase64 === undefined) throw unavailable();
  const bytes = Buffer.from(artifact.contentBase64, 'base64');
  if (
    bytes.toString('base64') !== artifact.contentBase64 ||
    bytes.length !== artifact.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new CollaborationContractError('snapshot_changed');
  if (bytes.some((b) => b < 32 && b !== 9 && b !== 10 && b !== 13)) throw unavailable();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (
      error instanceof TypeError &&
      'code' in error &&
      error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
    )
      throw unavailable();
    throw error;
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw unavailable();
  return text;
}
export function snapshotInputMaterial(snapshot: CollaborationSnapshot) {
  return {
    ...snapshotMaterial(snapshot),
    artifacts: snapshot.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      revision: artifact.revision,
      sha256: artifact.sha256,
      sourceConversationId: artifact.sourceConversationId,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      content: collaborationArtifactText(artifact),
    })),
  };
}
