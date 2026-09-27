import { useParams, useSearchParams } from 'react-router-dom';
import { SymposiumSavedReviewRecord } from './SymposiumSavedReviewRecord';

export function SymposiumSavedReviewRecordPage() {
  const { sessionId, recordId } = useParams();
  const [query] = useSearchParams();
  const hash = query.get('hash');
  if (!sessionId || !recordId || !hash || !/^[a-f0-9]{64}$/.test(hash)) {
    return <p role="alert">This saved review link is incomplete or invalid.</p>;
  }
  return (
    <main className="workspace-page">
      <h1>Saved review record</h1>
      <p>This immutable record requires your Mitzo login and access to its session.</p>
      <SymposiumSavedReviewRecord
        url={`/api/sessions/${encodeURIComponent(sessionId)}/symposium/reviews/records/${encodeURIComponent(recordId)}`}
        reference={{ id: recordId, hash }}
      />
    </main>
  );
}
