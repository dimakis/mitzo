import { useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import { shareTelosArtifact } from '../lib/share-file';

const BriefFields = z.strictObject({
  summary: z.string(),
  intent: z.string(),
  rationale: z.string().default(''),
  acceptanceCriteria: z.array(z.string()),
  taskHint: z.string().default(''),
});
/** A presentation of retained selections; opening this disclosure reads no new sources. */
export function TelosLinkedContext({
  context,
  summary = 'Linked brief · goal & parent context',
}: {
  context: TelosWorkRoleContextSelection;
  summary?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  let fields: z.infer<typeof BriefFields> | undefined;
  try {
    const parsed = BriefFields.safeParse(JSON.parse(context.brief.text));
    if (parsed.success) fields = parsed.data;
  } catch {
    /* Preserve reviewed plain text verbatim. */
  }
  const materials = [
    ...new Map(
      [...context.artifacts, ...context.sources.flatMap((source) => source.artifacts)].map(
        (material) => [`${material.artifactId}:${material.revision}:${material.sha256}`, material],
      ),
    ).values(),
  ];
  const openMaterial = async (id: string, revision: number) => {
    setError(null);
    try {
      await shareTelosArtifact(`/api/telos/artifacts/${id}?revision=${revision}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Retained material unavailable.');
    }
  };
  return (
    <details className="composer-session-details chat-launch-prompt">
      <summary>{summary}</summary>
      {fields ? (
        <>
          <h3>{fields.summary}</h3>
          <p>{fields.intent}</p>
          {fields.rationale && (
            <>
              <h4>Why this matters</h4>
              <p>{fields.rationale}</p>
            </>
          )}
          {!!fields.acceptanceCriteria.length && (
            <>
              <h4>Done when</h4>
              <ul>
                {fields.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </>
          )}
          {fields.taskHint && (
            <>
              <h4>Task hint</h4>
              <p>{fields.taskHint}</p>
            </>
          )}
        </>
      ) : (
        <p>{context.brief.text}</p>
      )}
      <h4>Overall goal</h4>
      <p>{context.overallGoal.text}</p>
      <p>
        <Link to={`/todos/${encodeURIComponent(context.overallGoal.itemId)}`}>
          Open overall goal
        </Link>
      </p>
      {!!context.parentCriteria.length && <h4>Parent criteria</h4>}
      {context.parentCriteria.map((parent) => (
        <section key={parent.itemId}>
          <p>
            <Link to={`/todos/${encodeURIComponent(parent.itemId)}`}>Parent item</Link>
          </p>
          <ul>
            {parent.criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
          <dl>
            <dt>Parent revision</dt>
            <dd>{parent.revision}</dd>
          </dl>
        </section>
      ))}
      {!!context.sources.length && <h4>Sources</h4>}
      {context.sources.map((source) => (
        <section key={source.snapshotId}>
          {source.source && source.selection.kind === 'selected' ? (
            source.source.namespace === 'mitzo' ? (
              <Link
                to={`/chat/${encodeURIComponent(source.source.conversationId)}?${new URLSearchParams({ telosItem: context.itemId, telosSource: source.snapshotId }).toString()}`}
              >
                Open original chat
              </Link>
            ) : (
              <a href={source.source.url}>Open original chat</a>
            )
          ) : (
            <p>Original message selection unavailable.</p>
          )}
          <dl>
            <dt>Source snapshot</dt>
            <dd>{source.snapshotId}</dd>
            {source.selection.kind === 'selected' && (
              <>
                <dt>Selected messages</dt>
                <dd>{source.selection.messageIds.join(', ')}</dd>
                <dt>Selected blocks</dt>
                <dd>{source.selection.blockIds.join(', ') || 'Whole selected messages'}</dd>
                <dt>Through sequence</dt>
                <dd>{source.selection.throughSequence}</dd>
              </>
            )}
          </dl>
        </section>
      ))}
      {!!materials.length && <h4>Materials</h4>}
      {materials.map((material) => (
        <section key={`${material.artifactId}:${material.revision}`}>
          <dl>
            <dt>Retained material</dt>
            <dd>{material.artifactId}</dd>
            <dt>Revision</dt>
            <dd>{material.revision}</dd>
            <dt>SHA-256</dt>
            <dd>{material.sha256}</dd>
          </dl>
          <button
            type="button"
            onClick={() => void openMaterial(material.artifactId, material.revision)}
          >
            Open material revision {material.revision}
          </button>
        </section>
      ))}
      <h4>Selected versions</h4>
      <dl>
        <dt>Brief revision</dt>
        <dd>{context.brief.revision}</dd>
        <dt>Brief SHA-256</dt>
        <dd>{context.brief.sha256}</dd>
        <dt>Goal revision</dt>
        <dd>{context.overallGoal.revision}</dd>
      </dl>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
