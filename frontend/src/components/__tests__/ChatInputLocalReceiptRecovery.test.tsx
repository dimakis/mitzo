// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from 'zustand';
import { createMitzoStore } from '../../../../packages/client/src/store';
import { ChatInput } from '../ChatInput';
const channel = vi.hoisted(() => ({ listener: (_event: Record<string, unknown>) => {} }));
vi.mock('../../../../packages/client/src/sse-connection', () => ({
  SseConnection: class {
    onMessage(fn: typeof channel.listener) {
      channel.listener = fn;
    }
    connect() {}
    getConnectionId() {
      return 'signed-device';
    }
    isConnected() {
      return true;
    }
    send() {
      return true;
    }
    getLastSeq() {
      return 0;
    }
    trackSeq() {}
    commitTranscriptCursor() {}
    acknowledgeReconnectSnapshot() {}
    getTrackedSessions() {
      return [];
    }
    clearSession() {}
    clearPendingSends() {}
    advanceSendScope() {}
    blockAuthentication() {}
    invalidateAuthentication() {}
    restoreAuthentication() {}
    checkAndReconnect() {}
    sendSuspend() {}
  },
}));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it.each([false, true])(
  'recovers lost Local acceptance in the open composer, preserving later edits: %s',
  async (edited) => {
    const command = {
      runOn: 'local' as const,
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      clientMsgId: 'exact-command',
      capabilityRevision: 'caps',
      runtime: {
        account: { accountId: 'work', provider: 'openai' as const, profileRevision: 'r1' },
        harness: 'codex' as const,
        targetId: 'mac',
        mode: 'agent' as const,
      },
      selection: {
        version: 1 as const,
        agent: { profileId: 'agent', revision: 1 },
        model: 'luna-fixture',
        thinking: 'low',
        context: { source: 'none' as const, revision: null },
        permission: { mode: 'agent' as const, revision: 0 as const },
      },
      payload: { text: 'Submitted exactly once' },
    };
    const reply = {
      messageId: 'reply',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ blockId: 'text', blockType: 'text', content: 'Reply visible in the same chat' }],
    };
    const fetch = vi.fn(async (path: string) => {
      if (path === '/local/send') throw Error('HTTP acknowledgement lost');
      if (path === '/local/send/receipt')
        return new Response(
          JSON.stringify({
            ok: true,
            clientMsgId: command.clientMsgId,
            sessionId: 'same-chat',
            dispatched: false,
            state: 'consumed',
          }),
          { status: 202 },
        );
      if (path === '/api/sessions/same-chat/messages?transcript=1')
        return new Response(JSON.stringify({ messages: [reply], current: null, cursor: 8 }));
      return new Response('[]');
    });
    const store = createMitzoStore({
      transport: { fetch },
      wsConfig: {
        buildUrl: () => '',
        createWebSocket: () => {
          throw Error('Unexpected WebSocket');
        },
      },
      sseConfig: { baseUrl: '', fetch },
      localFirstCommandConfig: { url: '/local/send', storage: localStorage },
    });
    function Harness() {
      const state = useStore(store);
      return (
        <>
          <ChatInput
            onSend={(text, _images, _context, onDelivery) =>
              state.sendLocalFirstCommand({ ...command, payload: { text } }, { onDelivery })
            }
            onStop={() => {}}
            running={false}
            sendDisabledReason={
              state.localCommand?.state === 'uncertain' ? 'Something went wrong.' : undefined
            }
          />
          <pre>{JSON.stringify(state.messages.messages)}</pre>
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: command.payload.text } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('Something went wrong.');
    expect(input).toHaveProperty('value', command.payload.text);
    if (edited) fireEvent.change(input, { target: { value: 'Independent follow-up draft' } });
    act(() => {
      channel.listener({
        type: 'session_id',
        sessionId: 'same-chat',
        clientMsgId: command.clientMsgId,
      });
      channel.listener({ type: 'message_start', sessionId: 'same-chat', messageId: 'reply' });
    });
    await waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
    await waitFor(() =>
      expect(input).toHaveProperty('value', edited ? 'Independent follow-up draft' : ''),
    );
    await waitFor(() => expect(screen.getByText(/Reply visible in the same chat/)).toBeTruthy());
    expect(screen.queryByText('Something went wrong.')).toBeNull();
    expect(fetch.mock.calls.filter(([path]) => path === '/local/send')).toHaveLength(1);
    expect(store.getState().sessions.active).toBe('same-chat');
  },
);
