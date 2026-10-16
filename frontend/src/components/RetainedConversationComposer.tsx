import { useRef, useState } from 'react';
import { ChatInput, type ChatInputDraftControl } from './ChatInput';

const EMPTY_CONTEXT: string[] = [];

/** Presentation adapter only. The retained native owner still queues, approves and stops.
 * It does not acquire ordinary dispatch authority or enable new collaboration routes.
 */
export function RetainedConversationComposer({
  sessionId,
  recipient,
  seats,
  onSelectRecipient,
  enabled,
  disabledReason,
  onQueue,
  onContinueInNewChat,
}: {
  sessionId: string;
  recipient: string;
  seats: { id: string; name: string }[];
  onSelectRecipient(id: string): void;
  enabled: boolean;
  disabledReason?: string;
  onQueue(ids: string[], text: string): Promise<boolean>;
  onContinueInNewChat?(draft: string): void;
}) {
  const draftControl = useRef<ChatInputDraftControl | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reason =
    disabledReason ??
    (!enabled
      ? 'Sending is unavailable. Your draft stays here.'
      : !recipient
        ? 'Use @ to choose who receives this prompt.'
        : busy
          ? 'Checking the queued message. Your draft stays here.'
          : undefined);
  return (
    <>
      <ChatInput
        key={`${sessionId}:${recipient}`}
        sessionId={sessionId}
        draftStorageKey={`mitzo-symposium-draft:${sessionId}:${recipient || 'unaddressed'}`}
        draftControl={draftControl}
        running={false}
        textOnly
        boundedFirstCommand
        externalContextBlocks={EMPTY_CONTEXT}
        collaboration={<></>}
        sendLabel="Queue for approval"
        sendDisabledReason={reason}
        responders={{
          members: seats,
          selectedIds: recipient ? [recipient] : [],
          maximum: 1,
          disabled: busy,
          onChange: (ids) => {
            if (!busy) onSelectRecipient(ids[0] ?? '');
          },
        }}
        onStop={() => {}}
        onSend={(text, images, context, delivered) => {
          if (
            reason ||
            busy ||
            images?.length ||
            context?.length ||
            !seats.some((s) => s.id === recipient)
          )
            return false;
          setBusy(true);
          setError('');
          void onQueue([recipient], text)
            .then((ok) => delivered?.(ok ? 'accepted' : 'failed'))
            .catch((cause) => {
              setError(cause instanceof Error ? cause.message : 'Could not queue message');
              delivered?.('failed');
            })
            .finally(() => setBusy(false));
          return true;
        }}
      />
      {!enabled && onContinueInNewChat && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError('');
            try {
              if (!draftControl.current?.readText) throw new Error('Draft is not ready. Retry.');
              onContinueInNewChat(draftControl.current.readText());
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Could not save the new chat draft. Retry.',
              );
            }
          }}
        >
          Continue in new chat
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
