// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useStore } from 'zustand';
import { createMitzoStore } from '../../../../packages/client/src/store';
import { ChatInput } from '../ChatInput';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionTray', () => ({
  SessionTray: ({
    selectedContextBlocks,
    onToggleContextBlock,
  }: {
    selectedContextBlocks: string[];
    onToggleContextBlock(name: string): void;
  }) => (
    <button onClick={() => onToggleContextBlock('exact context')}>
      {selectedContextBlocks.join(',') || 'Select context'}
    </button>
  ),
}));
vi.mock('../../lib/resizeImage', () => ({
  resizeImage: vi.fn(async (file: File) => ({
    data: file.name,
    mediaType: 'image/png',
    preview: `data:image/png;base64,${file.name}`,
  })),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function fixture(initialSession: string | null = 'child') {
  let ws: {
    readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send(data: string): void;
    close(): void;
  };
  const sent: Record<string, unknown>[] = [];
  let history: unknown = [];
  const store = createMitzoStore({
    transport: {
      connectWs: vi.fn(),
      fetch: vi.fn(async () => new Response(JSON.stringify(history), { status: 200 })),
    },
    wsConfig: {
      buildUrl: () => 'ws://fixture/ws',
      createWebSocket: () => {
        ws = {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: (data) => {
            sent.push(JSON.parse(data));
          },
          close() {
            this.readyState = 3;
          },
        };
        return ws;
      },
    },
  });
  function receive(message: Record<string, unknown>) {
    act(() => ws.onmessage?.({ data: JSON.stringify(message) }));
  }
  ws!.readyState = 1;
  ws!.onopen?.({});
  receive({ type: 'welcome', protocolVersion: 2, connectionId: 'fixture' });
  if (initialSession) await store.getState().switchSession(initialSession);
  receive({
    type: 'permission_request',
    sessionId: 'child',
    permId: 'permission',
    toolName: 'Bash',
    toolInput: 'inspect',
  });
  if (initialSession)
    receive({ type: 'session_state_changed', sessionId: initialSession, state: 'idle' });
  const stream = store.getState().messages.current;
  const permission = store.getState().messages.permission;
  const delivery = vi.fn();
  const onSend = vi.fn((text, images, contextBlocks, onDelivery, onSessionAssigned) => {
    store.getState().sendMessage(text, {
      images,
      contextBlocks,
      onDelivery: (status) => {
        delivery(status);
        onDelivery?.(status);
      },
      onSessionAssigned,
    });
    return true;
  });
  function Harness({ sessionId = initialSession ?? undefined }: { sessionId?: string }) {
    const messages = useStore(store, (state) => state.messages);
    const composerGeneration = useStore(store, (state) => state.chatDraftRevision);
    return (
      <ChatInput
        sessionId={sessionId}
        composerGeneration={composerGeneration}
        running={messages.running}
        onSend={onSend}
        onStop={() => {}}
        onInterrupt={(text, images, contextBlocks, onDelivery) => {
          store.getState().interruptMessage(text, {
            images,
            contextBlocks,
            onDelivery: (status) => {
              delivery(status);
              onDelivery?.(status);
            },
          });
        }}
      />
    );
  }
  const view = render(<Harness />);
  const input = () => screen.getByLabelText('Message Mitzo');
  async function compose(text: string, image?: string) {
    fireEvent.change(input(), { target: { value: text } });
    if (image) {
      fireEvent.change(view.container.querySelector('input[type=file]')!, {
        target: { files: [new File(['image'], image)] },
      });
      await screen.findByAltText('Attachment 1');
    }
  }
  const command = (control = 'send') => sent.filter((message) => message.type === control).at(-1)!;
  const reject = (message = command()) =>
    receive({
      type: 'session_control_rejected',
      sessionId: 'child',
      control: message.type,
      clientMsgId: message.clientMsgId,
      error: 'Use contributor controls',
    });
  return {
    ...view,
    renderScope: (sessionId: string) => view.rerender(<Harness sessionId={sessionId} />),
    remount: () => render(<Harness />),
    store,
    receive,
    input,
    compose,
    command,
    reject,
    delivery,
    onSend,
    history: (value: unknown) => {
      history = value;
    },
    stream,
    permission,
    running: (running: boolean) =>
      receive({
        type: 'session_state_changed',
        sessionId: 'child',
        state: running ? 'running' : 'idle',
      }),
  };
}

it('keeps idle child text, images and context until an exact ordinary receipt and preserves a refused claim', async () => {
  const f = await fixture();
  await f.compose('Ordinary refused input', 'input.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  expect(f.command()).toMatchObject({
    sessionId: 'child',
    prompt: 'Ordinary refused input',
    images: [{ data: 'input.png', mediaType: 'image/png' }],
    contextBlocks: ['exact context'],
  });
  expect(f.input()).toHaveProperty('value', 'Ordinary refused input');
  f.reject();
  expect(f.input()).toHaveProperty('value', 'Ordinary refused input');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  expect(screen.getByText('exact context')).toBeTruthy();
  expect(f.store.getState().messages.permission).toBe(f.permission);
  expect(f.store.getState().messages.running).toBe(false);
  expect(
    f.store.getState().messages.messages.some((m) => m.messageId === f.command().clientMsgId),
  ).toBe(false);
  expect(f.store.getState().messages.messages.at(-1)?.blocks[0].content).toBe(
    '**Error:** Use contributor controls',
  );
});

it('cannot clear an ordinary draft with a foreign-session echo or refusal sharing its exact command ID', async () => {
  const f = await fixture();
  await f.compose('Owned input', 'owned.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const command = f.command();
  f.receive({
    type: 'user_message',
    sessionId: 'foreign',
    messageId: command.clientMsgId,
    text: 'Foreign',
  });
  f.receive({
    type: 'session_control_rejected',
    sessionId: 'foreign',
    control: 'send',
    clientMsgId: command.clientMsgId,
    error: 'Foreign',
  });
  expect(f.input()).toHaveProperty('value', 'Owned input');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: command.clientMsgId,
    text: 'Owned input',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
  f.receive({ type: 'error', sessionId: 'child', error: 'Later provider failure' });
  expect(f.input()).toHaveProperty('value', '');
});

it('retains a refused ordinary payload in the explicit retry queue without overwriting newer input or storing image bytes', async () => {
  const f = await fixture();
  await f.compose('Refused payload', 'refused.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  await f.compose('Newer draft');
  f.reject();
  f.reject();
  expect(f.input()).toHaveProperty('value', 'Newer draft');
  expect(screen.getByText('Refused payload')).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem('mitzo-queue-child')!);
  expect(saved).toMatchObject([
    { text: 'Refused payload', contextBlocks: ['exact context'], requiresRetry: true },
  ]);
  expect(localStorage.getItem('mitzo-queue-child')).not.toContain('refused.png');
  f.running(false);
  f.running(true);
  f.running(false);
  expect(f.onSend).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Edit'));
  expect(f.input()).toHaveProperty('value', 'Refused payload');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
});

it.each(['auto', 'Send Now'] as const)(
  'recovers %s queued ordinary refusal and never automatically replays the refused payload',
  async (action) => {
    const f = await fixture();
    f.running(true);
    await f.compose('Queued payload', 'queue.png');
    fireEvent.click(screen.getByText('Select context'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    f.running(false);
    if (action === 'Send Now') {
      f.reject();
      fireEvent.click(screen.getByText('Send Now'));
    }
    const command = f.command();
    expect(command).toMatchObject({
      prompt: 'Queued payload',
      images: [{ data: 'queue.png', mediaType: 'image/png' }],
      contextBlocks: ['exact context'],
    });
    f.reject(command);
    expect(screen.getByText('Queued payload')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
      { text: 'Queued payload', contextBlocks: ['exact context'], requiresRetry: true },
    ]);
    const calls = f.onSend.mock.calls.length;
    f.running(true);
    f.running(false);
    expect(f.onSend).toHaveBeenCalledTimes(calls);
  },
);

it('does not apply old refusal to a newer conversation or consume its draft', async () => {
  const f = await fixture();
  await f.compose('Old input');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  f.renderScope('other');
  await f.compose('Other conversation');
  f.reject();
  expect(f.input()).toHaveProperty('value', 'Other conversation');
  expect(screen.queryByText('Old input')).toBeNull();
});

it('keeps new-chat input through assignment, then clears only its exact saved receipt', async () => {
  const f = await fixture(null);
  await f.compose('New conversation', 'new.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const command = f.command();
  expect(command.sessionId).toBeNull();
  f.receive({ type: 'session_id', sessionId: 'assigned', clientMsgId: command.clientMsgId });
  f.renderScope('assigned');
  expect(f.input()).toHaveProperty('value', 'New conversation');
  f.receive({
    type: 'user_message',
    sessionId: 'assigned',
    messageId: command.clientMsgId,
    text: 'New conversation',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
});

it('keeps an ended reasoning send pending across its correlated ordinary-session fork', async () => {
  const f = await fixture();
  await f.compose('Fork this input', 'fork.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  f.receive({ type: 'session_id', sessionId: 'new-chat', clientMsgId: c.clientMsgId });
  f.renderScope('new-chat');
  expect(f.delivery).not.toHaveBeenCalled();
  expect(f.input()).toHaveProperty('value', 'Fork this input');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  expect(screen.getByText('exact context')).toBeTruthy();
  f.receive({
    type: 'user_message',
    sessionId: 'new-chat',
    messageId: c.clientMsgId,
    text: 'Fork this input',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
  expect(screen.getByText('Select context')).toBeTruthy();
});

it('preserves later edits through the exact ordinary-session fork and original acceptance', async () => {
  const f = await fixture();
  await f.compose('Original input', 'original.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  await f.compose('Later draft');
  f.receive({ type: 'session_id', sessionId: 'new-chat', clientMsgId: c.clientMsgId });
  f.renderScope('new-chat');
  expect(f.input()).toHaveProperty('value', 'Later draft');
  f.receive({
    type: 'user_message',
    sessionId: 'new-chat',
    messageId: c.clientMsgId,
    text: 'Original input',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(f.input()).toHaveProperty('value', 'Later draft');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
});

it('keeps an unassigned draft in new-chat storage when navigation has no exact assignment', async () => {
  const f = await fixture(null);
  await f.compose('Unassigned input');
  f.renderScope('unrelated');
  expect(f.input()).toHaveProperty('value', '');
  expect(localStorage.getItem('mitzo-draft-new')).toBe('Unassigned input');
  expect(localStorage.getItem('mitzo-draft-unrelated')).toBeNull();
  expect(f.onSend).not.toHaveBeenCalled();
});

it('retires old receipts when genuine New resets an unassigned chat to another unassigned generation', async () => {
  const f = await fixture(null);
  await f.compose('Same intended prompt');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const old = f.command();
  act(() => f.store.getState().newSession());
  await f.compose('Same intended prompt');
  f.receive({
    type: 'user_message',
    sessionId: 'old-assigned',
    messageId: old.clientMsgId,
    text: 'Same intended prompt',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(f.input()).toHaveProperty('value', 'Same intended prompt');
  expect(f.store.getState().sessions.active).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(f.onSend).toHaveBeenCalledTimes(2);
  const fresh = f.store
    .getState()
    .messages.messages.filter((message) => message.role === 'user')
    .at(-1)!;
  expect(fresh.messageId).not.toBe(old.clientMsgId);
  expect(fresh.blocks[0].content).toBe('Same intended prompt');
});

it('removes only an accepted automatic queue record from its original conversation after navigation', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Accepted A', 'accepted.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Other A');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  f.running(false);
  const c = f.command();
  expect(c.prompt).toBe('Accepted A');
  localStorage.setItem('mitzo-queue-b', JSON.stringify([{ text: 'B queue', contextBlocks: [] }]));
  await act(() => f.store.getState().switchSession('b'));
  f.renderScope('b');
  await f.compose('B draft');
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: c.clientMsgId,
    text: 'Accepted A',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: 'Other A', contextBlocks: [] },
  ]);
  expect(f.input()).toHaveProperty('value', 'B draft');
  expect(screen.getByText('B queue')).toBeTruthy();
  await act(() => f.store.getState().switchSession('child'));
  f.renderScope('child');
  expect(screen.queryByText('Accepted A')).toBeNull();
  expect(screen.getByText('Other A')).toBeTruthy();
  expect(f.onSend).toHaveBeenCalledOnce();
});

it('keeps a known refused queued running interrupt under its original retry fence after navigation', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Interrupted A', 'interrupt.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  fireEvent.click(screen.getByText('Send Now'));
  const c = f.command('interrupt');
  await act(() => f.store.getState().switchSession('b'));
  f.renderScope('b');
  await f.compose('B draft');
  f.receive({
    type: 'session_control_rejected',
    sessionId: 'child',
    control: 'interrupt',
    clientMsgId: c.clientMsgId,
    error: 'Use contributor controls',
  });
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: 'Interrupted A', contextBlocks: ['exact context'], requiresRetry: true },
  ]);
  expect(localStorage.getItem('mitzo-queue-child')).not.toContain('interrupt.png');
  expect(f.input()).toHaveProperty('value', 'B draft');
  await act(() => f.store.getState().switchSession('child'));
  f.renderScope('child');
  expect(screen.getByText('Interrupted A')).toBeTruthy();
  expect(f.onSend).not.toHaveBeenCalled();
});

it('reconciles an accepted automatic queue entry in reopened A without removing its other work', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Accepted across reload');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Other A');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  f.running(false);
  const c = f.command();
  f.unmount();
  f.remount();
  expect(screen.getByText('Accepted across reload')).toBeTruthy();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: c.clientMsgId,
    text: 'Accepted across reload',
  });
  expect(screen.queryByText('Accepted across reload')).toBeNull();
  expect(screen.getByText('Other A')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: 'Other A', contextBlocks: [] },
  ]);
});

it('carries remaining work through an exact fork whose acceptance precedes the assigned render', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Forked first');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Remaining work');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  f.running(false);
  const c = f.command();
  f.receive({
    type: '_send_accepted',
    originalSessionId: 'child',
    sessionId: 'fork',
    clientMsgId: c.clientMsgId,
  });
  f.renderScope('fork');
  expect(screen.queryByText('Forked first')).toBeNull();
  expect(screen.getByText('Remaining work')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('mitzo-queue-fork')!)).toMatchObject([
    { text: 'Remaining work', contextBlocks: [] },
  ]);
});

it('locks queued and direct ordinary sends while an interrupt remains uncertain after running becomes idle', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Queued interrupt');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Other queued input');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  fireEvent.click(screen.getAllByText('Send Now')[0]);
  const c = f.command('interrupt');
  f.receive({
    type: '_send_uncertain',
    sessionId: 'child',
    clientMsgId: c.clientMsgId,
    error: 'Receipt unavailable',
  });
  f.running(false);
  await f.compose('Later direct draft');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(f.onSend).not.toHaveBeenCalled();
  expect(f.input()).toHaveProperty('value', 'Later direct draft');
  expect(screen.getByText('Other queued input')).toBeTruthy();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: c.clientMsgId,
    text: 'Queued interrupt',
  });
  expect(screen.queryByText('Queued interrupt')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(f.onSend).toHaveBeenCalledOnce();
});
it('accepts a native command only from its correlated result, leaving later input untouched', async () => {
  const f = await fixture();
  await f.compose('/skills');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  f.receive({
    type: 'native_command_result',
    sessionId: 'child',
    command: 'skills',
    content: 'Generic result',
  });
  expect(f.input()).toHaveProperty('value', '/skills');
  f.receive({
    type: 'native_command_result',
    sessionId: 'foreign',
    clientMsgId: c.clientMsgId,
    command: 'skills',
    content: 'Wrong session',
  });
  expect(f.input()).toHaveProperty('value', '/skills');
  f.receive({
    type: 'native_command_result',
    sessionId: 'child',
    clientMsgId: c.clientMsgId,
    command: 'skills',
    content: 'Exact saved result',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
});

it('retains uncertain delivery without another send, then consumes only its authoritative receipt', async () => {
  const f = await fixture();
  await f.compose('Uncertain input', 'uncertain.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  f.receive({
    type: '_send_uncertain',
    sessionId: 'child',
    clientMsgId: c.clientMsgId,
    error: 'Network receipt unavailable',
  });
  expect(f.input()).toHaveProperty('value', 'Uncertain input');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  expect(f.onSend).toHaveBeenCalledOnce();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: c.clientMsgId,
    text: 'Uncertain input',
  });
  expect(f.delivery.mock.calls.map(([status]) => status)).toEqual(['uncertain', 'accepted']);
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
});
it('returns a locally refused automatic queue send to explicit retry with original images and context', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Local refusal', 'local.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  f.onSend.mockImplementationOnce(() => {
    const beforeDispatch = JSON.parse(localStorage.getItem('mitzo-queue-child')!);
    expect(beforeDispatch).toMatchObject([
      { text: 'Local refusal', contextBlocks: ['exact context'], requiresRetry: true },
    ]);
    expect(beforeDispatch[0].queueEntryId).toMatch(/^[a-f0-9-]{36}$/);
    return false;
  });
  f.running(false);
  expect(screen.getByText('Local refusal')).toBeTruthy();
  expect(f.command()).toBeUndefined();
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toMatchObject([
    { text: 'Local refusal', contextBlocks: ['exact context'], requiresRetry: true },
  ]);
  fireEvent.click(screen.getByText('Edit'));
  expect(f.input()).toHaveProperty('value', 'Local refusal');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
});
it('preserves the newer queue and draft on successful ordinary drain, with explicit idle Edit retry acceptance', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('First');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Second');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Newer draft');
  f.running(false);
  const c = f.command();
  f.receive({ type: 'user_message', sessionId: 'child', messageId: c.clientMsgId, text: 'First' });
  expect(screen.queryByText('First')).toBeNull();
  expect(screen.getByText('Second')).toBeTruthy();
  expect(f.input()).toHaveProperty('value', 'Newer draft');
  f.running(true);
  f.running(false);
  f.reject();
  fireEvent.click(screen.getByText('Edit'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const retry = f.command();
  expect(retry.clientMsgId).not.toBe(c.clientMsgId);
  expect(retry.prompt).toBe('Second');
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: retry.clientMsgId,
    text: 'Second',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(localStorage.getItem('mitzo-queue-child')).toBeNull();
});

it('does not settle a foreign transcript but settles the original offscreen transcript without changing the new conversation', async () => {
  const f = await fixture();
  await f.compose('Original input');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  const row = {
    messageId: c.clientMsgId,
    role: 'user',
    timestamp: 1,
    blocks: [{ blockId: 'saved', blockType: 'text', content: 'Original input' }],
  };
  f.history([row]);
  await act(() => f.store.getState().switchSession('foreign'));
  f.renderScope('foreign');
  await f.compose('Foreign draft');
  expect(f.delivery).not.toHaveBeenCalled();
  f.history({ messages: [row], cursor: 3 });
  f.receive({ type: 'session_reconnect_snapshot', sessionId: 'child', cursor: 3, state: 'idle' });
  await waitFor(() => expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted'));
  expect(f.input()).toHaveProperty('value', 'Foreign draft');
});

it('retains queued uncertainty under the persisted retry fence without automatic replay', async () => {
  const f = await fixture();
  f.running(true);
  await f.compose('Uncertain queue', 'private.png');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  f.running(false);
  const c = f.command();
  f.receive({
    type: '_send_uncertain',
    sessionId: 'child',
    clientMsgId: c.clientMsgId,
    error: 'Receipt unavailable',
  });
  expect(screen.getByText('Uncertain queue')).toBeTruthy();
  expect(localStorage.getItem('mitzo-queue-child')).not.toContain('private.png');
  f.running(true);
  f.running(false);
  expect(f.onSend).toHaveBeenCalledOnce();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: c.clientMsgId,
    text: 'Uncertain queue',
  });
  expect(screen.queryByText('Uncertain queue')).toBeNull();
  expect(localStorage.getItem('mitzo-queue-child')).toBeNull();
});

it('binds an HTTP fork acceptance to its exact old command and ignores a foreign HTTP receipt', async () => {
  const f = await fixture();
  await f.compose('HTTP fork');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const c = f.command();
  f.receive({
    type: '_send_accepted',
    sessionId: 'foreign',
    originalSessionId: 'foreign',
    clientMsgId: c.clientMsgId,
  });
  expect(f.delivery).not.toHaveBeenCalled();
  expect(f.input()).toHaveProperty('value', 'HTTP fork');
  f.receive({
    type: '_send_accepted',
    sessionId: 'assigned-http',
    originalSessionId: 'child',
    clientMsgId: c.clientMsgId,
  });
  expect(f.store.getState().sessions.active).toBe('assigned-http');
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
});

it.each(['send', 'interrupt', 'automatic queue'] as const)(
  'retains exact refused %s input and explicit retry on HTTP without randomUUID',
  async (control) => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const f = await fixture();
    if (control !== 'send') f.running(true);
    fireEvent.click(screen.getByText('Select context'));
    await f.compose('Exact HTTP input', 'private-http.png');
    if (control === 'automatic queue') {
      fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
      f.running(false);
    } else fireEvent.keyDown(f.input(), { key: 'Enter' });
    const c = f.command(control === 'interrupt' ? 'interrupt' : 'send');
    expect(c).toMatchObject({
      prompt: 'Exact HTTP input',
      images: [{ data: 'private-http.png', mediaType: 'image/png' }],
      contextBlocks: ['exact context'],
    });
    await f.compose('Newer HTTP draft');
    if (control !== 'automatic queue')
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
    f.reject(c);
    expect(f.input()).toHaveProperty('value', 'Newer HTTP draft');
    expect(screen.getByText('Exact HTTP input')).toBeTruthy();
    const stored = localStorage.getItem('mitzo-queue-child')!;
    expect(stored).not.toContain('private-http.png');
    expect(JSON.parse(stored)).toEqual([
      {
        text: 'Exact HTTP input',
        contextBlocks: ['exact context'],
        requiresRetry: true,
        queueEntryId: expect.any(String),
      },
    ]);
    expect(f.store.getState().messages.permission).toBe(f.permission);
    f.running(false);
    f.running(true);
    f.running(false);
    expect(f.onSend).toHaveBeenCalledTimes(control === 'interrupt' ? 0 : 1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(f.input()).toHaveProperty('value', 'Exact HTTP input');
    expect(screen.getByAltText('Attachment 1')).toBeTruthy();
    expect(screen.getByText('exact context')).toBeTruthy();
  },
);
