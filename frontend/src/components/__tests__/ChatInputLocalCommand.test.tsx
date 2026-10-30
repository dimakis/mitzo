import { chatStorage } from '../../lib/large-chat-storage';
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import { createChatDraft } from '../../lib/chat-drafts';
import { prepareLocalFirstCommand } from '../../lib/explicit-local-chat';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
it('keeps one short failure with Retry while preserving the edited draft and blocking replacement sends', async () => {
  const send = vi.fn(() => true),
    retry = vi.fn();
  const props = {
    onSend: send,
    onStop: vi.fn(),
    running: false,
    initialText: 'Keep this message',
    sendDisabledReason: 'Something went wrong.',
    sendDisabledAction: { label: 'Retry', onClick: retry },
  };
  const view = render(<ChatInput {...props} />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Keep this message'));
  expect(screen.getAllByText('Something went wrong.')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'Keep my later edits too' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(input).toHaveValue('Keep my later edits too');
  expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();
  view.rerender(
    <ChatInput {...props} sendDisabledAction={{ ...props.sendDisabledAction, disabled: true }} />,
  );
  expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
});
it('keeps bounded running drafts and retained queues intact, exposes only Stop, and never drains at completion', async () => {
  localStorage.setItem(
    'mitzo-queue-bound',
    JSON.stringify([{ text: 'Original queued input', contextBlocks: [] }]),
  );
  const send = vi.fn(() => true),
    interrupt = vi.fn(),
    stop = vi.fn();
  const props = {
    sessionId: 'bound',
    initialText: 'Keep my follow-up draft',
    onSend: send,
    onInterrupt: interrupt,
    onStop: stop,
    boundedFirstCommand: true,
  };
  const { rerender } = render(<ChatInput {...props} running />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Keep my follow-up draft'));
  const retained = localStorage.getItem('mitzo-queue-bound');
  expect(screen.queryByRole('button', { name: 'Queue message' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Interrupt and send now' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send Now' })).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(interrupt).not.toHaveBeenCalled();
  expect(input).toHaveValue('Keep my follow-up draft');
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
  expect(stop).toHaveBeenCalledOnce();
  rerender(<ChatInput {...props} running={false} sendDisabledReason="First command only" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled());
  expect(send).not.toHaveBeenCalled();
  expect(localStorage.getItem('mitzo-queue-bound')).toBe(retained);
  expect(input).toHaveValue('Keep my follow-up draft');
});
it('does not turn a disabled running send into a new queue entry or clear its draft', async () => {
  render(
    <ChatInput
      onSend={vi.fn(() => true)}
      onStop={vi.fn()}
      running
      initialText="Keep this message"
      sendDisabledReason="Settings unavailable"
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Keep this message'));
  const queue = screen.getByRole('button', { name: 'Queue message' });
  expect(queue).toBeDisabled();
  fireEvent.click(queue);
  expect(input).toHaveValue('Keep this message');
  expect(localStorage.getItem('mitzo-queue-new')).toBeNull();
});
it('sends screenshots above the former 1 MiB command cap without removing them', async () => {
  const inventory = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  const draft = {
    ...createChatDraft(),
    text: 'Keep this prompt',
    images: [
      {
        data: 'AAAA'.repeat(270000),
        preview:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        mediaType: 'image/png',
      },
    ],
  };
  const send = vi.fn((..._args: unknown[]) => true);
  render(
    <ChatInput
      onSend={send}
      onStop={vi.fn()}
      running={false}
      boundedFirstCommand
      savedChatDraft={draft}
      validateSend={(text, images) =>
        prepareLocalFirstCommand(intent, inventory, {
          clientMsgId: '11111111-1111-4111-8111-111111111111',
          repositoryWorkspaceId: '22222222-2222-4222-8222-222222222222',
          mode: 'agent',
          text,
          images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
        }).reason
      }
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Keep this prompt'));
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  expect(screen.queryByText(/commands must fit within/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]).toEqual(
    expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ data: draft.images[0].data })]),
    ]),
  );
});

it('keeps guarded queued drafts unsent, retains their reply and drains one after completion', async () => {
  const send = vi.fn((..._args: unknown[]) => true);
  const reply = { messageId: 'earlier', role: 'assistant' as const, text: 'Earlier answer' };
  const props = {
    sessionId: 'bound',
    guardedConversation: true,
    initialText: 'Next task',
    onSend: send,
    onStop: vi.fn(),
    replyTarget: reply,
  };
  const { rerender } = render(<ChatInput {...props} running />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Next task'));
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('region', { name: 'Up next' })).toBeDefined();
  rerender(<ChatInput {...props} running={false} />);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][6]).toEqual(reply);
});

it('queues Enter during a guarded running turn and leaves steering as an explicit action', async () => {
  const onSend = vi.fn(() => true),
    onInterrupt = vi.fn();
  render(
    <ChatInput
      onSend={onSend}
      onStop={() => {}}
      onInterrupt={onInterrupt}
      interruptLabel="Steer current turn"
      guardedConversation
      running
      sessionId="queue-enter"
    />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Next task' } });
  expect(screen.getByRole('button', { name: 'Steer current turn' })).toBeDefined();
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(input).toHaveValue(''));
  expect(onSend).not.toHaveBeenCalled();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it('allows a distinct queued draft after uncertain steering without resending the correction', async () => {
  const send = vi.fn(() => true),
    steer = vi.fn((_text, _images, _context, delivery) => delivery('uncertain'));
  render(
    <ChatInput
      onSend={send}
      onStop={() => {}}
      onInterrupt={steer}
      interruptLabel="Steer current turn"
      guardedConversation
      running
      sessionId="uncertain-correction"
    />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Steer current turn' }));
  fireEvent.change(input, { target: { value: 'A different next task' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(send).not.toHaveBeenCalled();
  expect(steer).toHaveBeenCalledOnce();
});
function seedQueued(sessionId: string, texts: string[]) {
  localStorage.setItem(
    `mitzo-queue-${sessionId}`,
    JSON.stringify(
      texts.map((text, index) => ({ text, contextBlocks: [], queueEntryId: `entry-${index}` })),
    ),
  );
}
it('drains the next queued draft after completion precedes its delivery receipt', async () => {
  seedQueued('late-receipt', ['First', 'Second']);
  let receipt: ((status: 'accepted') => void) | undefined;
  const send = vi.fn((...args: unknown[]) => {
    receipt = args[3] as typeof receipt;
    return true;
  });
  const props = {
    sessionId: 'late-receipt',
    guardedConversation: true,
    onSend: send,
    onStop: vi.fn(),
  };
  const view = render(<ChatInput {...props} running />);
  fireEvent.click(screen.getByRole('button', { name: 'Steer with queued prompt 1' }));
  // No onInterrupt means this control is disabled; finish the current turn instead.
  view.rerender(<ChatInput {...props} running={false} />);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  // The first command starts and finishes before its HTTP receipt arrives.
  view.rerender(<ChatInput {...props} running />);
  view.rerender(<ChatInput {...props} running={false} />);
  expect(send).toHaveBeenCalledOnce();
  await act(async () => receipt?.('accepted'));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
});
it('uses the same command identity when two views drain one saved draft', async () => {
  seedQueued('two-views', ['One shared draft']);
  const first = vi.fn((..._args: unknown[]) => true),
    second = vi.fn((..._args: unknown[]) => true);
  const a = render(
    <ChatInput sessionId="two-views" guardedConversation onSend={first} onStop={vi.fn()} running />,
  );
  const b = render(
    <ChatInput
      sessionId="two-views"
      guardedConversation
      onSend={second}
      onStop={vi.fn()}
      running
    />,
  );
  a.rerender(
    <ChatInput
      sessionId="two-views"
      guardedConversation
      onSend={first}
      onStop={vi.fn()}
      running={false}
    />,
  );
  b.rerender(
    <ChatInput
      sessionId="two-views"
      guardedConversation
      onSend={second}
      onStop={vi.fn()}
      running={false}
    />,
  );
  await waitFor(() => expect(first).toHaveBeenCalledOnce());
  await waitFor(() => expect(second).toHaveBeenCalledOnce());
  expect(first.mock.calls[0][7]).toBe('entry-0');
  expect(second.mock.calls[0][7]).toBe('entry-0');
});
it('keeps a definitely rejected queued correction editable and pauses automatic dispatch', async () => {
  seedQueued('stale-queued', ['Correct that']);
  const send = vi.fn(() => true),
    steer = vi.fn((_text, _images, _ctx, receipt) => receipt('failed'));
  render(
    <ChatInput
      sessionId="stale-queued"
      guardedConversation
      onSend={send}
      onInterrupt={steer}
      onStop={vi.fn()}
      running
      interruptLabel="Steer current turn"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Steer with queued prompt 1' }));
  await waitFor(() => expect(steer).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole('button', { name: 'Resume queue' })).toBeDefined();
  expect(send).not.toHaveBeenCalled();
});
it('waits for the queued dispatch fence to commit before sending and keeps a refused write editable', async () => {
  seedQueued('flush-fence', ['Do this once']);
  let reject!: () => void;
  const flush = vi.spyOn(chatStorage, 'flush').mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = () => fail(Error('quota'));
      }),
  );
  const send = vi.fn(() => true);
  const props = {
    sessionId: 'flush-fence',
    guardedConversation: true,
    onSend: send,
    onStop: vi.fn(),
  };
  const view = render(<ChatInput {...props} running />);
  view.rerender(<ChatInput {...props} running={false} />);
  await waitFor(() => expect(flush).toHaveBeenCalledOnce());
  expect(send).not.toHaveBeenCalled();
  await act(async () => reject());
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }),
    ).toBeEnabled(),
  );
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Resume queue' })).toBeDefined();
});
it('does not drain another prompt merely because admission is accepted before the next turn starts', async () => {
  seedQueued('one-per-response', ['First', 'Second']);
  const send = vi.fn((_text, _images, _context, receipt) => {
    receipt('accepted');
    return true;
  });
  const props = {
    sessionId: 'one-per-response',
    guardedConversation: true,
    onSend: send,
    onStop: vi.fn(),
  };
  const view = render(<ChatInput {...props} running />);
  view.rerender(<ChatInput {...props} running={false} />);
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(send).toHaveBeenCalledOnce();
  expect(screen.getByRole('region', { name: 'Up next' })).toHaveTextContent('Second');
});
it('cold-opens a fenced ordinary prompt without replay and explicitly recovers the same identity', async () => {
  localStorage.setItem(
    'mitzo-queue-cold-send',
    JSON.stringify([
      {
        text: 'Original saved prompt',
        contextBlocks: [],
        queueEntryId: 'original-id',
        requiresRetry: true,
        dispatchPending: true,
        dispatchKind: 'send',
      },
    ]),
  );
  const send = vi.fn((...args: unknown[]) => {
    (args[3] as (status: string) => void)('accepted');
    return true;
  });
  render(
    <ChatInput
      sessionId="cold-send"
      guardedConversation
      running={false}
      onSend={send}
      onStop={vi.fn()}
    />,
  );
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery of queued prompt 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][7]).toBe('original-id');
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Up next' })).toBeNull());
});
it('cold-opens a fenced correction and recovers its original target instead of the successor turn', async () => {
  localStorage.setItem(
    'mitzo-queue-cold-steer',
    JSON.stringify([
      {
        text: 'Original correction',
        contextBlocks: [],
        queueEntryId: 'correction-id',
        requiresRetry: true,
        dispatchPending: true,
        dispatchKind: 'steer',
        steeringTargetCommandId: 'original-turn',
      },
    ]),
  );
  const steer = vi.fn((...args: unknown[]) => {
    (args[3] as (status: string) => void)('accepted');
  });
  render(
    <ChatInput
      sessionId="cold-steer"
      guardedConversation
      running
      steeringTargetCommandId="successor-turn"
      onSend={vi.fn(() => true)}
      onInterrupt={steer}
      interruptLabel="Steer current turn"
      onStop={vi.fn()}
    />,
  );
  expect(steer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery of queued prompt 1' }));
  await waitFor(() => expect(steer).toHaveBeenCalledOnce());
  expect(steer.mock.calls[0][5]).toBe('correction-id');
  expect(steer.mock.calls[0][6]).toBe('original-turn');
});
it('keeps an unconfirmed recovered ordinary dispatch fenced under the same identity on refusal', async () => {
  localStorage.setItem(
    'mitzo-queue-cold-refused',
    JSON.stringify([
      {
        text: 'Original saved prompt',
        contextBlocks: [],
        queueEntryId: 'original-id',
        requiresRetry: true,
        dispatchPending: true,
        dispatchKind: 'send',
      },
    ]),
  );
  const send = vi.fn((...args: unknown[]) => {
    (args[3] as (status: string) => void)('failed');
    return true;
  });
  render(
    <ChatInput
      sessionId="cold-refused"
      guardedConversation
      running={false}
      onSend={send}
      onStop={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check delivery of queued prompt 1' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(JSON.parse(localStorage.getItem('mitzo-queue-cold-refused')!)[0]).toMatchObject({
    queueEntryId: 'original-id',
    dispatchPending: true,
  });
  expect(
    screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }),
  ).toBeDisabled();
});
it('clears a cold ordinary fence from authoritative request progress without another dispatch', async () => {
  localStorage.setItem(
    'mitzo-queue-cold-proven',
    JSON.stringify([
      {
        text: 'Already accepted',
        contextBlocks: [],
        queueEntryId: 'accepted-id',
        requiresRetry: true,
        dispatchPending: true,
        dispatchKind: 'send',
      },
    ]),
  );
  const send = vi.fn(() => true);
  render(
    <ChatInput
      sessionId="cold-proven"
      guardedConversation
      running={false}
      onSend={send}
      onStop={vi.fn()}
      messages={[
        {
          messageId: 'accepted-id',
          role: 'user',
          blocks: [{ blockId: 'text', blockType: 'text', content: 'Already accepted' }],
          commandState: 'completed',
        },
      ]}
    />,
  );
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Up next' })).toBeNull());
  expect(send).not.toHaveBeenCalled();
});
