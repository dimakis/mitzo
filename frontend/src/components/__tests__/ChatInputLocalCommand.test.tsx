// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
