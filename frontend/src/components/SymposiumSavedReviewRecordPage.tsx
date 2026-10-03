import { useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import { PermissionBanner } from './PermissionBanner';
import { SymposiumPublication } from './SymposiumPublication';
import { useParams, useSearchParams } from 'react-router-dom';
import { SymposiumSavedReviewRecord } from './SymposiumSavedReviewRecord';

export function SymposiumSavedReviewRecordPage() {
  const { sessionId, recordId } = useParams();
  const [query] = useSearchParams();
  const hash = query.get('hash');
  const switchSession = useMitzoStore((s) => s.switchSession);
  const activeSession = useMitzoStore((s) => s.sessions.active);
  const permission = useMitzoStore((s) => s.messages.permission);
  const respond = useMitzoStore((s) => s.respondToPermission);
  const expire = useMitzoStore((s) => s.expirePermission);
  const getConnectionId = useMitzoStore((s) => s.getTransportConnectionId);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState('');
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
      <p>
        Open this session here to approve publication while keeping this saved record visible. This
        does not start a model.
      </p>
      <button
        onClick={() =>
          void (async () => {
            setError('');
            if (!getConnectionId()) {
              setError('Connect this tab before opening the approval session.');
              return;
            }
            await switchSession(sessionId);
            setOpened(true);
          })()
        }
      >
        Open session for approval
      </button>
      {error && <p role="alert">{error}</p>}
      {opened && activeSession === sessionId && (
        <>
          <SymposiumPublication sessionId={sessionId} record={{ id: recordId, hash }} />
          {permission && (
            <PermissionBanner
              {...permission}
              onExpire={expire}
              onRespond={(id, decision, _tool, answers) => respond(id, decision, answers)}
            />
          )}
        </>
      )}
    </main>
  );
}
