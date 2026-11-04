// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SendMessageOptions } from '@mitzo/client';
import { ChatInput } from '../ChatInput';
import { createChatDraft, getChatDraft } from '../../lib/chat-drafts';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('keeps the status rail mounted above the actual composer without autosave announcements', () => {
  const draft = createChatDraft();
  const view = render(
    <ChatInput savedChatDraft={draft} running={false} onSend={() => false} onStop={() => {}} />,
  );
  const rail = screen.getByRole('region', { name: 'Conversation status' });
  const input = screen.getByLabelText('Message Mitzo');
  fireEvent.change(input, { target: { value: 'A quietly saved draft' } });
  expect(getChatDraft(draft.id)?.text).toBe('A quietly saved draft');
  expect(screen.queryByText(/Draft saved on|Saving draft on/)).toBeNull();
  view.rerender(
    <ChatInput savedChatDraft={draft} running onSend={() => false} onStop={() => {}} />,
  );
  expect(screen.getByRole('region', { name: 'Conversation status' })).toBe(rail);
  expect(rail.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(input.getAttribute('placeholder')).not.toContain('interrupt');
  for (const name of [
    'Commands',
    'Attach images or PDF',
    'Expand input',
    'Symposium collaboration',
    'Stop generation',
  ])
    expect(screen.getByRole('button', { name })).toBeTruthy();
});

it.each(['accepted', 'failed'] as const)(
  'moves submitted images with the text and preserves the next draft on %s',
  (outcome) => {
    const draft = {
      ...createChatDraft(),
      text: 'Original screenshot',
      images: [
        { data: 'b2xk', mediaType: 'image/png' as const, preview: 'data:image/png;base64,b2xk' },
      ],
    };
    let receipt: SendMessageOptions['onDelivery'];
    render(
      <ChatInput
        savedChatDraft={draft}
        running={false}
        onStop={() => {}}
        onSend={(_text, _images, _context, delivery) => {
          receipt = delivery;
          return true;
        }}
      />,
    );
    const input = screen.getByLabelText('Message Mitzo');
    expect(screen.getByAltText('Attachment 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(input).toHaveProperty('value', '');
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
    // Retention is still owned by the exact original draft until its receipt.
    expect(getChatDraft(draft.id)?.images).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Independent next draft' } });
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    act(() => receipt?.(outcome));
    expect(input).toHaveProperty('value', 'Independent next draft');
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    if (outcome === 'accepted') expect(getChatDraft(draft.id)?.images).toHaveLength(0);
    else expect(localStorage.getItem('mitzo-queue-new')).toContain('Original screenshot');
  },
);

it('keeps a synchronously refused screenshot draft visible', () => {
  const draft = {
    ...createChatDraft(),
    text: 'Keep this',
    images: [
      { data: 'b2xk', mediaType: 'image/png' as const, preview: 'data:image/png;base64,b2xk' },
    ],
  };
  render(
    <ChatInput savedChatDraft={draft} running={false} onStop={() => {}} onSend={() => false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Keep this');
  expect(screen.getByAltText('Attachment 1')).toBeTruthy();
});

it('keeps a correction restriction available in the send menu', () => {
  render(
    <ChatInput
      initialText="A correction"
      running
      onStop={() => {}}
      onSend={() => false}
      onInterrupt={() => {}}
      interruptDisabledReason="Waiting for the active turn to be confirmed."
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  const correction = screen.getByRole('menuitem', { name: 'Send correction' });
  expect(correction).toHaveProperty('disabled', true);
  expect(correction).toHaveProperty('title', 'Waiting for the active turn to be confirmed.');
});

it('returns keyboard focus to the existing input after a correction menu action', async () => {
  render(
    <ChatInput
      initialText="A correction"
      running
      onStop={() => {}}
      onSend={() => false}
      onInterrupt={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Send correction' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message Mitzo')));
});
