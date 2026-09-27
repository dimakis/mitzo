import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';

/** Authenticated read of an exact record; server remains the integrity/owner authority. */
export function SymposiumSavedReviewRecord({
  url,
  reference,
}: {
  url: string;
  reference: { id: string; hash: string };
}) {
  const [record, setRecord] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setRecord('');
    setError('');
    void apiFetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Could not open the saved record. Check your Mitzo login and access.');
        const value = await response.json();
        if (
          value?.recordId !== reference.id ||
          value?.contentHash !== reference.hash ||
          !value?.snapshot ||
          typeof value.snapshot !== 'object'
        )
          throw new Error('The saved record does not match the selected immutable reference.');
        if (!controller.signal.aborted) setRecord(JSON.stringify(value, null, 2));
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Could not load the saved record.');
      });
    return () => controller.abort();
  }, [url, reference.id, reference.hash, retry]);
  return (
    <section aria-label="Saved review record">
      {record && (
        <label>
          Saved immutable review record
          <textarea readOnly value={record} />
        </label>
      )}
      {!record && !error && <p role="status">Loading saved record…</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry saved record
          </button>
        </>
      )}
    </section>
  );
}
