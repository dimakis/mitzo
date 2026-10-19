// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { ChatInput } from '../ChatInput';
import type { ComposerResponderSelection } from '../ComposerResponders';
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('selects @all through the existing composer keyboard path using the real all intent', () => {
  function Surface() {
    const [responders, set] = useState<CollaborationMessageInput['responders']>({
      kind: 'default',
    });
    const [selectedIds, setIds] = useState<string[]>([]);
    return (
      <>
        <ChatInput
          running={false}
          onSend={() => false}
          onStop={() => {}}
          responders={{
            members: [
              { id: 'a', name: 'Architect' },
              { id: 'b', name: 'Reviewer' },
            ],
            selectedIds,
            responders,
            onChange(ids, intent) {
              setIds(ids);
              set(intent!);
            },
          }}
        />
        <output aria-label="Intent">{JSON.stringify(responders)}</output>
      </>
    );
  }
  render(<Surface />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Discuss this @all' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByLabelText('Intent').textContent).toBe('{"kind":"all"}');
  expect(input.value).toBe('Discuss this ');
});
it('moves keyboard focus past an unavailable matching recipient', () => {
  render(
    <ChatInput
      running={false}
      onSend={() => false}
      onStop={() => {}}
      responders={{
        members: [
          { id: 'a', name: 'Reviewer old', unavailableReason: 'Unavailable' },
          { id: 'b', name: 'Reviewer new' },
        ],
        selectedIds: [],
        onChange: vi.fn(),
      }}
    />,
  );
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  fireEvent.change(input, { target: { value: '@rev' } });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Reviewer new' }));
});
it.each<Partial<ComposerResponderSelection>>([
  { responders: { kind: 'selected', sessionIds: [] } },
  { selectedIds: ['a'] },
  { responders: { kind: 'selected', sessionIds: ['gone'] } },
])(
  'keeps explicit empty or unavailable responders from falling back to a send: %j',
  (selection) => {
    const onSend = vi.fn();
    render(
      <ChatInput
        running={false}
        onSend={onSend}
        onStop={() => {}}
        responders={{
          members: [{ id: 'a', name: 'Architect', unavailableReason: 'Unavailable' }],
          selectedIds: [],
          onChange: vi.fn(),
          ...selection,
        }}
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'Retain this' } });
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  },
);
it('keeps the authoritative backend refusal ahead of recipient selection hints', () => {
  render(
    <ChatInput
      running={false}
      onSend={() => false}
      onStop={() => {}}
      sendDisabledReason="Backend unavailable"
      responders={{
        members: [],
        selectedIds: [],
        responders: { kind: 'selected', sessionIds: [] },
        onChange: vi.fn(),
      }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe('Backend unavailable');
});
