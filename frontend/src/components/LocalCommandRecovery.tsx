import { useEffect, useRef, useState } from 'react';
import { localCommandInFlight, type MitzoStoreState } from '@mitzo/client';
import { HomeDialog } from './HomeDialog';

/** Shared recovery for both chat layouts. Reviewing never submits a message. */
export function useLocalCommandRecovery({
  command,
  connected,
  recover,
  withdraw,
  refresh,
  scope,
}: {
  command: MitzoStoreState['localCommand'];
  connected: boolean;
  recover(): boolean;
  withdraw(commandId: string): Promise<boolean>;
  refresh(): void;
  scope: string;
}) {
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [hasReview, setHasReview] = useState(false);
  const [pending, setPending] = useState<symbol | null>(null);
  const review = useRef<{ token: symbol; scope: string } | undefined>(undefined);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(
    () => () => {
      review.current = undefined;
    },
    [],
  );
  const busy = pending !== null && pending === review.current?.token;
  const [error, setError] = useState<string | null>(null);
  const request = command?.request;
  const eligible =
    request?.runOn === 'local' &&
    request.runtime.harness === 'claude-sdk' &&
    'sessionId' in request &&
    typeof request.sessionId === 'string' &&
    command?.ordinaryPhase !== 'first' &&
    !localCommandInFlight(command?.state) &&
    !['consumed', 'blocked'].includes(command?.state ?? '');
  const current = eligible && request.clientMsgId === reviewing;
  return {
    action: {
      label: eligible ? 'Review delivery' : 'Retry',
      disabled:
        localCommandInFlight(command?.state) ||
        (command?.state !== 'blocked' && (!connected || !request)),
      onClick: () => {
        if (eligible) {
          setHasReview(true);
          review.current = { token: Symbol(), scope };
          setError(null);
          setReviewing(request.clientMsgId);
        } else recover();
      },
    },
    // Normal chats need no modal DOM. Once opened, retain the shared sheet
    // through closing/navigation so its focus and motion lifetime stay intact.
    dialog: hasReview ? (
      <HomeDialog
        title="Message delivery"
        open={!!current}
        onClose={() => {
          if (!busy) setReviewing(null);
        }}
      >
        <p>
          Retry checks the same message. Withdraw keeps your draft and prevents this message from
          running, if it has not already been accepted.
        </p>
        <p>After withdrawal, review chat settings and send again when ready.</p>
        {error && <p role="alert">{error}</p>}
        <div className="home-inline-actions">
          <button
            type="button"
            className="home-secondary"
            disabled={busy || !connected || !current}
            onClick={() => {
              setReviewing(null);
              recover();
            }}
          >
            Retry original message
          </button>
          <button
            type="button"
            className="home-secondary"
            disabled={busy || !connected || !current}
            onClick={async () => {
              const owner = review.current;
              if (!current || busy || !owner) return;
              const stillCurrent = () =>
                review.current === owner && currentScope.current === owner.scope;
              setPending(owner.token);
              try {
                const withdrawn = await withdraw(request.clientMsgId);
                if (!stillCurrent()) return;
                if (withdrawn) {
                  setReviewing(null);
                  refresh();
                } else
                  setError(
                    'Withdrawal is unconfirmed. Keep this draft and check the original message.',
                  );
              } catch {
                console.warn('[mitzo] Command withdrawal unavailable', {
                  code: 'command_withdrawal_unavailable',
                });
                if (stillCurrent())
                  setError(
                    'Withdrawal is unconfirmed. Keep this draft and check the original message.',
                  );
              } finally {
                if (review.current === owner)
                  setPending((pending) => (pending === owner.token ? null : pending));
              }
            }}
          >
            Withdraw and review
          </button>
        </div>
      </HomeDialog>
    ) : null,
  };
}
