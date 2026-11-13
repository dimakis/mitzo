import { useState } from 'react';
import type { MessageReplyContext } from '@mitzo/protocol';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { activeSteeringCommandId, createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import type { WebSocketLike } from '../../packages/client/src/ws-connection';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatStatusMessage } from '../../frontend/src/components/ChatStatusMessage';
import { ComposerStatusProvider } from '../../frontend/src/components/ComposerStatus';
import { useTurnSteering } from '../../frontend/src/hooks/useTurnSteering';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import './chat-queue-steering.css';
const socket: WebSocketLike = {
  readyState: 1,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  send() {},
  close() {},
};
const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: { buildUrl: () => '/offline', createWebSocket: () => socket },
});
socket.onopen?.({});
socket.onmessage?.({
  data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'fixture' }),
});
let seq = 0;
const emit = (event: Record<string, unknown>) =>
  socket.onmessage?.({
    data: JSON.stringify({ sessionId: 'queue-fixture', seq: ++seq, ...event }),
  });
emit({ type: 'session_id' });
emit({
  type: 'user_message',
  messageId: 'first',
  text: 'Review Akram’s accomplishments and current priorities.',
});
emit({ type: 'ordinary_provider_dispatch_started', messageId: 'first' });
if (new URLSearchParams(location.search).has('prepared')) {
  emit({ type: 'ordinary_command_completed', messageId: 'first', status: 'completed' });
  emit({ type: 'ordinary_provider_dispatch_started', messageId: 'prepared-repository-fixture' });
}
emit({ type: 'session_state_changed', state: 'running' });
let sent = 0;
let setFeedback: (value: { status?: string; error?: string }) => void = () => {};
let holdDelivery = false;
let pendingReceipt: ((status: 'accepted') => void) | undefined;
const spoken: string[] = [];
const voice = {
  available: true,
  recording: false,
  transcribing: false,
  micBlocked: false,
  error: null,
  partialTranscript: '',
  ttsAvailable: true,
  speaking: false,
  voices: [],
  selectedVoice: '',
  startRecording: async () => {},
  stopRecording: async () => '',
  cancelRecording() {},
  speak: async (text: string) => {
    spoken.push(text);
  },
  stopSpeaking() {},
  setVoice() {},
};
function Fixture() {
  const [reply, setReply] = useState<MessageReplyContext>();
  const [feedback, updateFeedback] = useState<{ status?: string; error?: string }>({});
  setFeedback = updateFeedback;
  const messages = useMitzoStore((s) => s.messages);
  const target = activeSteeringCommandId(messages);
  const steering = useTurnSteering('queue-fixture', target, true);
  return (
    <main className="queue-steering-fixture">
      <header>
        <strong>Quarterly connections</strong>
        <span>Akram · current conversation</span>
      </header>
      <ChatArea
        voice={voice}
        onReply={setReply}
        messages={messages.messages}
        current={messages.current}
        running={messages.running}
        permission={null}
        onPermissionRespond={() => {}}
      />
      <div className="queue-steering-composer">
        <ChatStatusMessage status={feedback.status} error={feedback.error} />
        <ChatStatusMessage
          error={steering.error}
          status={steering.busy ? 'Sending correction…' : undefined}
          busy={steering.busy}
          action={
            steering.retry ? { label: 'Retry correction', onClick: steering.retry } : undefined
          }
        />
        <ChatInput
          voice={voice}
          tokenState={{
            agentContext: 5000,
            contextCeiling: 200000,
            sessionTotal: 9000,
            numTurns: 2,
            turnIndex: 1,
            numCompactions: 0,
          }}
          replyTarget={reply}
          onClearReply={() => setReply(undefined)}
          messages={messages.messages}
          current={messages.current}
          steeringTargetCommandId={target}
          sessionId="queue-fixture"
          guardedConversation
          running={messages.running}
          interruptLabel="Steer current turn"
          onSend={(
            text,
            _images,
            _context,
            receipt,
            _assignment,
            _draft,
            replyTo,
            queuedCommandId,
          ) => {
            void fetch('/fixture/queue', {
              method: 'POST',
              body: JSON.stringify({
                text,
                replyToMessageId: replyTo?.messageId,
                clientMsgId: queuedCommandId,
              }),
            });
            emit({
              type: 'user_message',
              messageId: `queued-${++sent}`,
              text,
              ...(replyTo ? { inReplyTo: replyTo } : {}),
            });
            if (holdDelivery) pendingReceipt = receipt;
            else receipt?.('accepted');
            return true;
          }}
          onInterrupt={(
            text,
            images,
            _context,
            receipt,
            replyTo,
            queuedCommandId,
            retainedTarget,
            onDefinitiveRefusal,
          ) =>
            steering.submit(
              text,
              receipt,
              replyTo?.messageId,
              queuedCommandId,
              retainedTarget,
              onDefinitiveRefusal,
              images?.map(({ data, mediaType }) => ({ data, mediaType })),
            )
          }
          onStop={() => {
            void fetch('/fixture/stop', { method: 'POST' });
          }}
        />
      </div>
    </main>
  );
}
(window as unknown as { queueFixture: unknown }).queueFixture = {
  emit,
  feedback(value: { status?: string; error?: string }) {
    setFeedback(value);
  },
  holdDelivery(value: boolean) {
    holdDelivery = value;
  },
  acceptDelivery() {
    pendingReceipt?.('accepted');
    pendingReceipt = undefined;
  },
  spoken,
  answerEarlier() {
    emit({ type: 'ordinary_reply_source', messageId: 'answer-first', replyToMessageId: 'first' });
    emit({ type: 'message_start', messageId: 'answer-first' });
    emit({ type: 'block_start', messageId: 'answer-first', blockId: 'text', blockType: 'text' });
    emit({
      type: 'block_delta',
      messageId: 'answer-first',
      blockId: 'text',
      blockType: 'text',
      delta: 'I checked the source answers. We can now review accomplishments together.',
    });
    emit({ type: 'block_end', messageId: 'answer-first', blockId: 'text', blockType: 'text' });
    emit({ type: 'message_end', messageId: 'answer-first' });
  },
};
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <MitzoStoreProvider value={store}>
      <ComposerStatusProvider>
        <Fixture />
      </ComposerStatusProvider>
    </MitzoStoreProvider>
  </MemoryRouter>,
);
