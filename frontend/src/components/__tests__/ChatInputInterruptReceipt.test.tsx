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
  localStorage.clear();
});

async function fixture() {
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
  const store = createMitzoStore({
    transport: {
      connectWs: vi.fn(),
      fetch: vi.fn(async () => new Response('[]', { status: 200 })),
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
  await store.getState().switchSession('child');
  receive({ type: 'session_state_changed', sessionId: 'child', state: 'running' });
  receive({ type: 'message_start', sessionId: 'child', messageId: 'active-turn' });
  receive({
    type: 'permission_request',
    sessionId: 'child',
    permId: 'permission',
    toolName: 'Bash',
    toolInput: 'inspect',
  });
  const stream = store.getState().messages.current;
  const permission = store.getState().messages.permission;
  const delivery = vi.fn();
  const onSend = vi.fn().mockReturnValue(true);
  function Harness({ sessionId = 'child' }: { sessionId?: string }) {
    const messages = useStore(store, (state) => state.messages);
    return (
      <ChatInput
        sessionId={sessionId}
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
  const command = () => sent.filter((message) => message.type === 'interrupt').at(-1)!;
  const reject = (message = command()) =>
    receive({
      type: 'session_control_rejected',
      sessionId: 'child',
      control: 'interrupt',
      clientMsgId: message.clientMsgId,
      error: 'Use contributor controls',
    });
  return {
    ...view,
    renderScope: (sessionId: string) => view.rerender(<Harness sessionId={sessionId} />),
    store,
    receive,
    input,
    compose,
    command,
    reject,
    delivery,
    onSend,
    stream,
    permission,
  };
}

it('preserves running Enter text, image and internal context until an exact receipt and settles refusal nonterminally', async () => {
  const f = await fixture();
  await f.compose('Exact submitted draft', 'submitted.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  expect(f.command()).toMatchObject({
    prompt: 'Exact submitted draft',
    images: [{ data: 'submitted.png', mediaType: 'image/png' }],
    contextBlocks: ['exact context'],
  });
  expect(f.input()).toHaveProperty('value', 'Exact submitted draft');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  const original = f.command();
  f.reject();
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('failed');
  expect(
    f.store
      .getState()
      .messages.messages.some((message) => message.messageId === f.command().clientMsgId),
  ).toBe(false);
  expect(f.store.getState().messages.running).toBe(true);
  expect(f.store.getState().messages.current).toBe(f.stream);
  expect(f.store.getState().messages.permission).toBe(f.permission);
  expect(f.input()).toHaveProperty('value', 'Exact submitted draft');
  expect(screen.getByText('exact context')).toBeTruthy();
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  f.reject();
  expect(f.delivery).toHaveBeenCalledTimes(1);
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const retried = f.command();
  expect(retried.clientMsgId).not.toBe(original.clientMsgId);
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: retried.clientMsgId,
    text: 'Exact submitted draft',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
});

it('recovers a late rejected payload separately from newer draft and queued input without idle replay', async () => {
  const f = await fixture();
  await f.compose('Independent queued draft', 'queued.png');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await f.compose('Rejected exact draft', 'rejected.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const rejected = f.command();
  fireEvent.change(f.input(), { target: { value: 'Newer untouched draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  await f.compose('Newer untouched draft', 'newer.png');
  f.reject(rejected);
  expect(f.input()).toHaveProperty('value', 'Newer untouched draft');
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(
    'data:image/png;base64,newer.png',
  );
  expect(screen.getByText('Rejected exact draft')).toBeTruthy();
  f.receive({ type: 'session_state_changed', sessionId: 'child', state: 'idle' });
  expect(f.onSend).toHaveBeenCalledExactlyOnceWith(
    'Independent queued draft',
    [{ data: 'queued.png', mediaType: 'image/png', preview: 'data:image/png;base64,queued.png' }],
    undefined,
  );
  f.receive({ type: 'session_state_changed', sessionId: 'child', state: 'running' });
  f.receive({ type: 'session_state_changed', sessionId: 'child', state: 'idle' });
  expect(f.onSend).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(f.input()).toHaveProperty('value', 'Rejected exact draft');
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(
    'data:image/png;base64,rejected.png',
  );
  expect(screen.getByText('exact context')).toBeTruthy();
});

it('keeps newer compose edits when the original interrupt is accepted', async () => {
  const f = await fixture();
  await f.compose('Accepted original', 'original.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const command = f.command();
  fireEvent.change(f.input(), { target: { value: 'Newer draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  await f.compose('Newer draft', 'newer.png');
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: command.clientMsgId,
    text: 'Accepted original',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  expect(f.input()).toHaveProperty('value', 'Newer draft');
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(
    'data:image/png;base64,newer.png',
  );
  expect(localStorage.getItem('mitzo-queue-child')).toBeNull();
});

it('retains a refused queued interrupt for explicit editing and never automatically replays it on idle', async () => {
  const f = await fixture();
  await f.compose('Queued explicit retry', 'queued.png');
  fireEvent.click(screen.getByText('Select context'));
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  fireEvent.click(screen.getByText('Send Now'));
  f.reject();
  expect(screen.getByText('Queued explicit retry')).toBeTruthy();
  f.receive({ type: 'session_state_changed', sessionId: 'child', state: 'idle' });
  expect(f.onSend).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('mitzo-queue-child')!)).toEqual([
    { text: 'Queued explicit retry', contextBlocks: ['exact context'], requiresRetry: true },
  ]);
  fireEvent.click(screen.getByText('Edit'));
  expect(f.input()).toHaveProperty('value', 'Queued explicit retry');
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(
    'data:image/png;base64,queued.png',
  );
  expect(screen.getByText('exact context')).toBeTruthy();
});

it('invalidates old composer receipt ownership across navigation and cannot release a newer interrupt', async () => {
  const f = await fixture();
  await f.compose('Old scoped draft');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const old = f.command();
  f.renderScope('other');
  f.renderScope('child');
  await f.compose('New scoped draft');
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const newer = f.command();
  expect(newer.clientMsgId).not.toBe(old.clientMsgId);
  f.reject(old);
  expect(localStorage.getItem('mitzo-queue-child')).toBeNull();
  expect(f.input()).toHaveProperty('value', 'New scoped draft');
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: newer.clientMsgId,
    text: 'New scoped draft',
  });
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
});

it('cannot acknowledge an interrupt from another conversation even with the same command ID', async () => {
  const f = await fixture();
  await f.compose('Exact owned draft', 'owned.png');
  fireEvent.keyDown(f.input(), { key: 'Enter' });
  const command = f.command();
  f.receive({
    type: 'user_message',
    sessionId: 'other',
    messageId: command.clientMsgId,
    text: 'Foreign echo',
  });
  expect(f.delivery).not.toHaveBeenCalled();
  expect(f.input()).toHaveProperty('value', 'Exact owned draft');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  f.receive({
    type: 'user_message',
    sessionId: 'child',
    messageId: command.clientMsgId,
    text: 'Exact owned draft',
  });
  expect(f.delivery).toHaveBeenCalledExactlyOnceWith('accepted');
  await waitFor(() => expect(f.input()).toHaveProperty('value', ''));
});
