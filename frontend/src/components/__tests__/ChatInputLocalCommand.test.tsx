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
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }));
  expect(retry).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(input).toHaveValue('Keep my later edits too');
  expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();
  view.rerender(
    <ChatInput {...props} sendDisabledAction={{ ...props.sendDisabledAction, disabled: true }} />,
  );
  expect(screen.getByRole('button', { name: 'Retry', exact: true })).toBeDisabled();
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
it('validates the complete Local envelope, keeps oversized attachments, and resumes only after removal', async () => {
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
  const send = vi.fn(() => true);
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
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(screen.getByText(/Remove or resize attachments/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Preview attachment 1' })).toBeVisible();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  expect(input).toHaveValue('Keep this prompt');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

it('submits guarded queued input immediately and preserves old local queues without replay', async () => {
  localStorage.setItem(
    'mitzo-queue-bound',
    JSON.stringify([{ text: 'Older queue', contextBlocks: [] }]),
  );
  const send = vi.fn((..._args: unknown[]) => true);
  const props = {
    sessionId: 'bound',
    guardedConversation: true,
    initialText: 'Admit with current settings',
    onSend: send,
    onStop: vi.fn(),
  };
  const { rerender } = render(<ChatInput {...props} running />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  await waitFor(() => expect(input).toHaveValue('Admit with current settings'));
  const retained = localStorage.getItem('mitzo-queue-bound');
  fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toBe('Admit with current settings');
  expect(localStorage.getItem('mitzo-queue-bound')).toBe(retained);
  rerender(<ChatInput {...props} running={false} />);
  expect(send).toHaveBeenCalledOnce();
  expect(localStorage.getItem('mitzo-queue-bound')).toBe(retained);
});
