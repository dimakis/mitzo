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
      <h3>Overall goal</h3>
      <p>{context.overallGoal.text}</p>
      <p>
        <Link
          className="session-work-link"
          to={`/todos/${encodeURIComponent(context.overallGoal.itemId)}`}
        >
          Open overall goal
        </Link>
      </p>
      {!!context.parentCriteria.length && <h3>Parent outcome</h3>}
      {context.parentCriteria.map((parent) => (
        <section key={parent.itemId}>
          <p>
            <Link className="session-work-link" to={`/todos/${encodeURIComponent(parent.itemId)}`}>
              Parent item
            </Link>
          </p>
          <ul>
            {parent.criteria.map((criterion, index) => (
              <li key={index}>{criterion}</li>
            ))}
          </ul>
        </section>
      ))}
      <h3>This item</h3>
      {fields ? (
        <>
          <h4>{fields.summary}</h4>
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
      {!!context.sources.length && <h4>Sources</h4>}
      {context.sources.map((source) => (
        <section key={source.snapshotId}>
          {source.source && source.selection.kind === 'selected' ? (
            source.source.namespace === 'mitzo' ? (
              <Link
                className="session-work-link"
                to={`/chat/${encodeURIComponent(source.source.conversationId)}?${new URLSearchParams({ telosItem: context.itemId, telosSource: source.snapshotId }).toString()}`}
              >
                Open original chat
              </Link>
            ) : (
              <a className="session-work-link" href={source.source.url}>
                Open original chat
              </a>
            )
          ) : (
            <p>Original message selection unavailable.</p>
          )}
          {source.selection.kind === 'selected' && (
            <p>
              {source.selection.messageIds.length}{' '}
              {source.selection.messageIds.length === 1 ? 'selected message' : 'selected messages'}
            </p>
          )}
        </section>
      ))}
      {!!materials.length && <h4>Materials</h4>}
      {materials.map((material) => (
        <section key={`${material.artifactId}:${material.revision}`}>
          <p>Retained material · Revision {material.revision}</p>
          <button
            className="home-secondary"
            type="button"
            onClick={() => void openMaterial(material.artifactId, material.revision)}
          >
            Open material revision {material.revision}
          </button>
        </section>
      ))}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
