// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComposerResponders } from '../ComposerResponders';

afterEach(cleanup);
function Surface() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('Review this');
  const [selected, setSelected] = useState(['lead']);
  return (
    <>
      <textarea
        ref={input}
        aria-label="Draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ComposerResponders
        input={input}
        text={text}
        onTextChange={setText}
        onOpenChange={vi.fn()}
        selection={{
          inline: true,
          members: [
            { id: 'lead', name: 'Mitzo' },
            { id: 'review', name: 'Bob' },
          ],
          selectedIds: selected,
          responders: { kind: 'selected', sessionIds: selected },
          onChange: setSelected,
        }}
      />
      <output aria-label="Targets">{selected.join(',')}</output>
    </>
  );
}
it('selects one or several agents inline without opening a popup or sending a request', () => {
  render(<Surface />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Review this @');
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
  expect(screen.getByLabelText('Targets').textContent).toBe('lead,review');
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('Review this ');
  fireEvent.click(screen.getByRole('button', { name: 'Mitzo' }));
  expect(screen.getByLabelText('Targets').textContent).toBe('review');
});
it('starts collapsed and collapses again without changing the selected agents or draft', () => {
  render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Choose who replies' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Bob' })).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
  const draft = (screen.getByLabelText('Draft') as HTMLTextAreaElement).value;
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Bob' })).toBeNull();
  expect(screen.getByLabelText('Targets').textContent).toBe('lead,review');
  expect((screen.getByLabelText('Draft') as HTMLTextAreaElement).value).toBe(draft);
});
