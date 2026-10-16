// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ChatInput } from '../ChatInput';
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const members = [
  { id: 'a', name: 'Analyst' },
  { id: 'b', name: 'Reviewer' },
];
function Surface({ maximum }: { maximum?: number }) {
  const [selectedIds, onChange] = useState<string[]>([]);
  return (
    <>
      <ChatInput
        running={false}
        onStop={() => {}}
        onSend={() => false}
        responders={{ members, selectedIds, onChange, maximum }}
      />
      <output aria-label="Selected IDs">{selectedIds.join(',')}</output>
    </>
  );
}
it('uses stable IDs for one, several and all responders without a separate recipient form', () => {
  render(<Surface />);
  expect(screen.queryByRole('combobox', { name: 'Message recipient' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Analyst' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  expect(screen.getByLabelText('Selected IDs').textContent).toBe('a,b');
  expect(screen.getByRole('button', { name: 'Choose who replies' }).textContent).toContain(
    'Reviewer',
  );
  fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
  expect(screen.getByLabelText('Selected IDs').textContent).toBe('a,b');
  fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
});
it('opens from @, preserves surrounding draft text and clears only the matching selector token', () => {
  render(<Surface maximum={1} />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Inspect this @rev' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  expect(input.value).toBe('Inspect this ');
  expect(screen.getByLabelText('Selected IDs').textContent).toBe('b');
  expect(document.activeElement).toBe(input);
});
it('keeps an unknown @ as draft text when dismissed and never changes selection from email', () => {
  render(<Surface />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Email person@example.test' } });
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
  fireEvent.change(input, { target: { value: 'Inspect @unknown' } });
  expect(screen.getByText('No matching agent.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
  expect(input.value).toBe('Inspect @unknown');
  expect(screen.getByLabelText('Selected IDs').textContent).toBe('');
});
it('does not offer all when the retained adapter supports only one recipient', () => {
  render(<Surface maximum={1} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  expect(screen.queryByRole('button', { name: 'All agents' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  expect(screen.getByLabelText('Selected IDs').textContent).toBe('b');
});

it('moves keyboard focus from the @ draft into matching choices and returns on Escape', () => {
  render(<Surface maximum={1} />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
  fireEvent.change(input, { target: { value: 'Review @rev' } });
  input.focus();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Reviewer' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
});
