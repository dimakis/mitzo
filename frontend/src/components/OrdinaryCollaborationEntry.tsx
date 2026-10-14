import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useOutputContributors } from '../hooks/useOutputContributors';
import { OutputContributorPanel } from './OutputContributorPanel';
import { HomeDialog } from './HomeDialog';
import { EmptyState } from './EmptyState';
import { UiIcon } from './UiIcon';

const CollaborationContext = createContext<{ sessionId: string; open(): void } | null>(null);

/** Above responsive screens: the requested work view survives a viewport change. */
export function OrdinaryCollaborationHost({
  sessionId,
  refreshKey = '',
  children,
}: {
  sessionId: string | null;
  refreshKey?: string | number;
  children: ReactNode;
}) {
  const [requestedSession, setRequestedSession] = useState<string | null>(null);
  const open = Boolean(sessionId && requestedSession === sessionId);
  useEffect(() => setRequestedSession(null), [sessionId]);
  const work = useOutputContributors(sessionId, open, refreshKey);
  return (
    <CollaborationContext.Provider
      value={sessionId ? { sessionId, open: () => setRequestedSession(sessionId) } : null}
    >
      {children}
      {open && (
        <HomeDialog title="Collaborate on selected work" onClose={() => setRequestedSession(null)}>
          <p>
            Select an exact draft and invite independent contributors using your existing accounts.
          </p>
          {work && <OutputContributorPanel {...work} />}
          {work &&
            !work.loading &&
            !work.error &&
            !work.candidates.length &&
            !work.outputs.length && (
              <EmptyState
                icon={<UiIcon name="file" size={24} />}
                title="No finalized drafts yet"
                subtitle="Finish a response in this conversation, then select the work you want to share."
              />
            )}
        </HomeDialog>
      )}
    </CollaborationContext.Provider>
  );
}

/** Explicit ordinary entry; does not open dedicated native Symposium setup. */
export function OrdinaryCollaborationEntry({ sessionId }: { sessionId: string }) {
  const flow = useContext(CollaborationContext);
  if (!flow || flow.sessionId !== sessionId)
    return (
      <OrdinaryCollaborationHost sessionId={sessionId}>
        <OrdinaryCollaborationEntry sessionId={sessionId} />
      </OrdinaryCollaborationHost>
    );
  return (
    <button
      type="button"
      onClick={(event) => {
        event.currentTarget.focus();
        flow.open();
      }}
    >
      Collaborate
    </button>
  );
}
