import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HomeDialog } from './HomeDialog';
import { readApiJson } from '../lib/api-json-read';
import type { SandboxOwnershipReview as Review } from '../types/sandboxes';
const explanations: Record<string, string> = {
  lifecycle_missing: 'No managed lifecycle record establishes cleanup authority.',
  checkpoint_unverified:
    'A recovery checkpoint for this resource has not been verified through the managed lifecycle.',
  owner_unresolved:
    'No exact saved physical owner was found. A resource name or age does not establish ownership.',
  ownership_conflict:
    'More than one saved conversation refers to this resource. Resolve ownership before cleanup.',
  symposium: 'This resource has Symposium custody. Preserve it for the Symposium owner.',
  migration:
    'This resource is retained as a migration source or candidate. Preserve its migration evidence.',
  resource_error:
    'The gateway reports an error. Recovery and contents require separate investigation.',
};
export function SandboxOwnershipReview({
  item,
  onClose,
}: {
  item: { id: string; name: string; state: string };
  onClose(): void;
}) {
  const [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setReview(null);
    setError('');
    void readApiJson<Review>(
      '/api/sandboxes/' + encodeURIComponent(item.id) + '/ownership',
      abort.signal,
    )
      .then((result) => {
        if (abort.signal.aborted) return;
        if (
          !result?.physical ||
          result.canDelete !== false ||
          !Array.isArray(result.owners) ||
          !Array.isArray(result.blockers) ||
          result.physical.id !== item.id ||
          result.physical.name !== item.name
        )
          throw Error('Sandbox identity changed. Refresh inventory.');
        setReview(result);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError(
            'Ownership review is unavailable. The sandbox is retained. Refresh and try again.',
          );
      });
    return () => abort.abort();
  }, [item.id, item.name, revision]);
  return (
    <HomeDialog title="Review sandbox ownership" onClose={onClose}>
      <dl className="sandbox-facts">
        <div>
          <dt>Sandbox</dt>
          <dd>
            <code>{item.name}</code>
          </dd>
        </div>
        <div>
          <dt>Physical ID</dt>
          <dd>
            <code>{item.id}</code>
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{review?.physical.state ?? item.state}</dd>
        </div>
      </dl>
      {error ? (
        <p role="alert">{error}</p>
      ) : !review ? (
        <p role="status">Reading saved ownership…</p>
      ) : (
        <>
          <h3 className="sandbox-group-title">Saved ownership evidence</h3>
          {review.owners.length ? (
            review.owners.map((owner, index) => (
              <div key={owner.conversationId + owner.relation + index}>
                <p>{owner.title ?? 'Saved conversation'}</p>
                <p>
                  {owner.accountLabel ?? owner.accountId} · {owner.ownerKind ?? 'Unverified owner'}{' '}
                  · {owner.relation.replaceAll('_', ' ')}
                </p>
                <Link
                  className="home-secondary"
                  to={'/chat/' + encodeURIComponent(owner.conversationId)}
                >
                  Open saved chat
                </Link>
                <p>
                  <code>{owner.conversationId}</code>
                </p>
              </div>
            ))
          ) : (
            <p>No saved owner found for this exact physical resource.</p>
          )}
          <h3 className="sandbox-group-title">Why cleanup remains blocked</h3>
          <ul>
            {review.blockers.map((blocker) => (
              <li key={blocker}>
                {explanations[blocker] ?? 'Ownership and recovery require further review.'}
              </li>
            ))}
          </ul>
          <p className="sandbox-caption">
            Saved provenance does not adopt this sandbox or authorize deletion. Review the saved
            chat and recovery evidence before making changes. Existing files, chats and archives are
            retained.
          </p>
        </>
      )}
      <div className="sandbox-actions">
        <button className="home-secondary" onClick={() => setRevision((value) => value + 1)}>
          Recheck ownership
        </button>
        <button className="home-secondary" onClick={onClose}>
          Done
        </button>
      </div>
    </HomeDialog>
  );
}
