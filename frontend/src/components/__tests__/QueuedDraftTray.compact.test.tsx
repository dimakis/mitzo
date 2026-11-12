// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useQueuedMessages, type QueuedMessage } from '../../hooks/useQueuedMessages';
import { chatStorage } from '../../lib/large-chat-storage';
import { QueuedDraftTray } from '../QueuedDraftTray';
import { ChatInput } from '../ChatInput';
import { ComposerStatusProvider } from '../ComposerStatus';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const messages: QueuedMessage[] = ['First draft', 'Second draft', 'Third draft'].map((text, i) => ({
  queueEntryId: `q-${i}`,
  text,
  images: [],
  contextBlocks: [],
}));
function tray(queue = messages, onUpdate = vi.fn(() => true), blockedReason?: string) {
  return (
    <QueuedDraftTray
      queue={queue}
      paused={false}
      busy={false}
      running
      blocked={!!blockedReason}
      blockedReason={blockedReason}
      nativeSteer
      onPause={vi.fn()}
      onSend={vi.fn()}
      onUpdate={onUpdate}
      onRemove={vi.fn()}
      onEditingChange={vi.fn()}
    />
  );
}

it('keeps the actual queue inline above the composer while the status rail is mounted', async () => {
  render(
    <ComposerStatusProvider>
      <ChatInput
        sessionId="compact-inline"
        running
        onSend={() => false}
        onStop={() => {}}
        onInterrupt={() => {}}
      />
    </ComposerStatusProvider>,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Inline queue draft' },
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Queue message' })));
  const queue = await screen.findByRole('region', { name: 'Up next' });
  expect(queue.closest('dialog')).toBeNull();
  expect(
    queue.compareDocumentPosition(screen.getByLabelText('Message Mitzo')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Minimize queue' }));
  expect(screen.getByRole('button', { name: 'Expand queue' })).toHaveTextContent(
    'Inline queue draft',
  );
  expect(screen.getByRole('button', { name: 'Pause queue' })).toBeEnabled();
});

it('reorders directly and makes a draft next without sending or opening a dialog', async () => {
  const update = vi.fn(() => true);
  render(tray(messages, update));
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(1, messages[1], 0));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Done reordering' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 3' }));
  expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Third draft');
  fireEvent.click(screen.getByRole('button', { name: 'Make next' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith(2, messages[2], 0));
});

it('explains unavailable steering and keeps local ordering available', () => {
  render(
    tray(
      messages,
      vi.fn(() => true),
      'Waiting for the active turn to be confirmed.',
    ),
  );
  expect(screen.getByText('Waiting for the active turn to be confirmed.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Steer with queued prompt 1' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  expect(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' })).toBeEnabled();
});

it('keeps unsaved text when Make next changes dispatch position', async () => {
  const update = vi.fn(() => true);
  render(tray(messages, update));
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 2' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'Keep this unsaved change' },
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make next' })));
  expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Keep this unsaved change');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(update).toHaveBeenLastCalledWith(
    1,
    expect.objectContaining({ text: 'Keep this unsaved change' }),
    0,
  );
});

it('requires Save or Cancel before switching to another inline editor', () => {
  render(tray());
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'Retain this draft' },
  });
  expect(
    screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 2' }),
  ).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('Retain this draft');
});

it('retains the changed position when Make next is recovered before saving edited text', async () => {
  function Harness() {
    const store = useQueuedMessages('move-retry-editor');
    return (
      <>
        <button onClick={() => store.enqueue(messages[0])}>Seed first</button>
        <button onClick={() => store.enqueue(messages[1])}>Seed second</button>
        <QueuedDraftTray
          queue={store.queue}
          paused
          busy={false}
          running
          blocked={false}
          nativeSteer
          onPause={vi.fn()}
          onSend={vi.fn()}
          onUpdate={store.update}
          onRetryOrder={store.retryPersistence}
          onRemove={store.remove}
          onEditingChange={vi.fn()}
        />
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText('Seed first'));
  fireEvent.click(screen.getByText('Seed second'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 2' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'Edited second' },
  });
  vi.spyOn(chatStorage, 'flush').mockRejectedValueOnce(Error('injected flush failure'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Make next' })));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving order' })),
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(JSON.parse(chatStorage.getItem('mitzo-queue-move-retry-editor')!)[0].text).toBe(
    'Edited second',
  );
});

it('keeps receipt checks available for pending messages with context changes', () => {
  const send = vi.fn();
  render(
    <QueuedDraftTray
      queue={[{ ...messages[0], dispatchPending: true, contextBlocks: ['project'] }]}
      paused={false}
      busy={false}
      running
      blocked
      recoveryBlocked={false}
      nativeSteer
      onPause={vi.fn()}
      onSend={send}
      onUpdate={() => true}
      onRemove={vi.fn()}
      onEditingChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery of queued prompt 1' }));
  expect(send).toHaveBeenCalledWith(0);
});

it('does not move or cross a delivery-fenced message', () => {
  render(tray([{ ...messages[0], dispatchPending: true }, ...messages.slice(1)]));
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  expect(screen.getByRole('button', { name: 'Move queued prompt 1 later' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move queued prompt 2 later' })).toBeEnabled();
});

it('retains visible failure and blocks drain when an order save cannot be flushed', async () => {
  vi.spyOn(chatStorage, 'flush').mockRejectedValueOnce(Error('disk unavailable'));
  const editing = vi.fn();
  render(
    <QueuedDraftTray
      queue={messages}
      paused={false}
      busy={false}
      running
      blocked={false}
      nativeSteer
      onPause={vi.fn()}
      onSend={vi.fn()}
      onUpdate={() => true}
      onRemove={vi.fn()}
      onEditingChange={editing}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save dispatch order');
  expect(editing).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Retry saving order' })).toBeEnabled();
});

it('dispatches the reordered first draft on completion through the shared composer', async () => {
  // This proves the shared consumer contract, not a provider/runtime matrix.
  const send = vi.fn((_text: string) => true),
    sessionId = 'shared-queue-dispatch';
  const view = render(
    <ChatInput
      sessionId={sessionId}
      running
      onSend={send}
      onStop={() => {}}
      onInterrupt={() => {}}
    />,
  );
  for (const text of ['Original first', 'New first']) {
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: text } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Queue message' })));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' })),
  );
  expect(send).not.toHaveBeenCalled();
  view.rerender(
    <ChatInput
      sessionId={sessionId}
      running={false}
      onSend={send}
      onStop={() => {}}
      onInterrupt={() => {}}
    />,
  );
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0][0]).toBe('New first');
  expect(
    within(screen.getByRole('region', { name: 'Up next' })).getByText('Original first'),
  ).toBeTruthy();
});

it('retains identities, attachments and reply references when the persisted queue is reordered', async () => {
  function Harness() {
    const store = useQueuedMessages('compact-persisted');
    return (
      <>
        <button
          onClick={() =>
            store.enqueue({
              ...messages[0],
              retainAttachments: true,
              images: [
                { data: 'AAAA', preview: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
              ],
              replyTo: { messageId: 'reply', role: 'assistant', text: 'Exact source' },
            })
          }
        >
          Seed first
        </button>
        <button onClick={() => store.enqueue(messages[1])}>Seed second</button>
        <QueuedDraftTray
          queue={store.queue}
          paused
          busy={false}
          running
          blocked={false}
          nativeSteer
          onPause={vi.fn()}
          onSend={vi.fn()}
          onUpdate={store.update}
          onRemove={store.remove}
          onEditingChange={vi.fn()}
        />
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText('Seed first'));
  fireEvent.click(screen.getByText('Seed second'));
  const before = JSON.parse(chatStorage.getItem('mitzo-queue-compact-persisted')!);
  fireEvent.click(screen.getByRole('button', { name: 'Reorder dispatch order' }));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Move queued prompt 2 earlier' })),
  );
  expect(JSON.parse(chatStorage.getItem('mitzo-queue-compact-persisted')!)).toEqual(
    before.reverse(),
  );
});
