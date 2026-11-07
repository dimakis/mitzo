// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from '../ChatInput';
import { createChatDraft } from '../../lib/chat-drafts';
import { queueDraft, sendQueued } from '../../test-utils/queued-draft-controls';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('offers a direct interrupt beside Queue and Stop without a send overflow', () => {
  const interrupt = vi.fn();
  render(
    <ChatInput
      initialText="Change course"
      running
      onSend={() => false}
      onStop={() => {}}
      onInterrupt={interrupt}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Send options' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send now' }));
  expect(interrupt).toHaveBeenCalledOnce();
  expect(interrupt.mock.calls[0][0]).toBe('Change course');
  expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy();
});

it('updates a restricted correction in place when its active turn becomes available', () => {
  const props = {
    initialText: 'Change course',
    running: true,
    onSend: () => false,
    onStop: vi.fn(),
    onInterrupt: vi.fn(),
  };
  const view = render(
    <ChatInput {...props} interruptDisabledReason="Waiting for the active turn to be confirmed." />,
  );
  const interrupt = screen.getByRole('button', { name: 'Interrupt and send now' });
  expect(interrupt).toHaveProperty('disabled', true);
  expect(interrupt).toHaveAccessibleDescription('Waiting for the active turn to be confirmed.');
  view.rerender(<ChatInput {...props} />);
  expect(screen.getByRole('button', { name: 'Interrupt and send now' })).toBe(interrupt);
  expect(interrupt).toHaveProperty('disabled', false);
  fireEvent.click(interrupt);
  expect(props.onInterrupt).toHaveBeenCalledOnce();
});

it('does not wait for an animation frame to release an acknowledged interrupt', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  const interrupt = vi.fn<NonNullable<Parameters<typeof ChatInput>[0]['onInterrupt']>>();
  render(
    <ChatInput
      initialText="First correction"
      running
      onSend={() => false}
      onStop={() => {}}
      onInterrupt={interrupt}
    />,
  );
  const input = screen.getByLabelText('Message Mitzo');
  // The existing keyboard path isolates dispatch from the toolbar redesign.
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(interrupt).toHaveBeenCalledOnce();
  act(() => interrupt.mock.calls[0][3]?.('accepted'));
  fireEvent.change(input, { target: { value: 'Second correction' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(interrupt).toHaveBeenCalledTimes(2);
  expect(interrupt.mock.calls[1][0]).toBe('Second correction');
});

it('allows interrupting after the initial send even when animation frames are suspended', async () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  const interrupt = vi.fn();
  const onSend: Parameters<typeof ChatInput>[0]['onSend'] = (
    _text,
    _images,
    _context,
    delivery,
  ) => {
    delivery?.('accepted');
    return true;
  };
  const props = { initialText: 'Initial request', onSend, onStop: vi.fn(), onInterrupt: interrupt };
  const view = render(<ChatInput {...props} running={false} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
  view.rerender(<ChatInput {...props} running />);
  const input = screen.getByLabelText('Message Mitzo');
  fireEvent.change(input, { target: { value: 'Change course' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(interrupt).toHaveBeenCalledOnce();
  expect(interrupt.mock.calls[0][0]).toBe('Change course');
});

it('keeps an unacknowledged interrupt fenced while frames are suspended', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  const interrupt = vi.fn();
  render(
    <ChatInput
      initialText="Original correction"
      running
      onSend={() => false}
      onStop={() => {}}
      onInterrupt={interrupt}
    />,
  );
  const input = screen.getByLabelText('Message Mitzo');
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Separate correction' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(interrupt).toHaveBeenCalledOnce();
  expect(input).toHaveProperty('value', 'Separate correction');
});

it('steers an attached screenshot with its exact text and keeps it until acknowledgement', () => {
  const interrupt = vi.fn<NonNullable<Parameters<typeof ChatInput>[0]['onInterrupt']>>();
  const image = {
    data: 'aGk=',
    mediaType: 'image/png' as const,
    preview: 'data:image/png;base64,aGk=',
  };
  const draft = { ...createChatDraft(), text: 'Use this screenshot', images: [image] };
  render(
    <ChatInput
      savedChatDraft={draft}
      running
      guardedConversation
      interruptLabel="Steer current turn"
      onSend={() => false}
      onStop={() => {}}
      onInterrupt={interrupt}
    />,
  );
  const button = screen.getByRole('button', { name: 'Steer current turn' });
  expect(button).toHaveProperty('disabled', false);
  expect(button.textContent).toBe('');
  fireEvent.click(button);
  expect(interrupt.mock.calls[0].slice(0, 3)).toEqual(['Use this screenshot', [image], undefined]);
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
  act(() => interrupt.mock.calls[0][3]?.('accepted'));
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
});

it('can explicitly steer with a queued screenshot without stopping or sending another command', async () => {
  const interrupt = vi.fn();
  const send = vi.fn(() => false);
  const stop = vi.fn();
  const image = {
    data: 'aGk=',
    mediaType: 'image/png' as const,
    preview: 'data:image/png;base64,aGk=',
  };
  render(
    <ChatInput
      savedChatDraft={{ ...createChatDraft(), text: 'Queued screenshot', images: [image] }}
      running
      guardedConversation
      interruptLabel="Steer current turn"
      steeringTargetCommandId="original-turn"
      onSend={send}
      onStop={stop}
      onInterrupt={interrupt}
    />,
  );
  await queueDraft();
  await sendQueued();
  expect(interrupt).toHaveBeenCalledOnce();
  expect(interrupt.mock.calls[0].slice(0, 3)).toEqual(['Queued screenshot', [image], undefined]);
  expect(interrupt.mock.calls[0][6]).toBe('original-turn');
  expect(send).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});
