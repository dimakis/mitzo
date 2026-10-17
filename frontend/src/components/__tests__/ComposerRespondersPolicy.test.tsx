// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { ComposerResponders } from '../ComposerResponders';

afterEach(cleanup);
const members = [
  { id: 'session-one', name: 'Reviewer', repliesByDefault: true },
  { id: 'session-two', name: 'Reviewer', unavailableReason: 'Session unavailable' },
];
function Surface() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('Keep this draft');
  const [selectedIds, setIds] = useState<string[]>([]);
  const [responders, setResponders] = useState<CollaborationMessageInput['responders']>({
    kind: 'default',
  });
  return (
    <>
      <textarea
        aria-label="Draft"
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ComposerResponders
        input={input}
        text={text}
        onTextChange={setText}
        onOpenChange={() => {}}
        selection={{
          members,
          selectedIds,
          responders,
          onChange(ids, next) {
            setIds(ids);
            setResponders(next!);
          },
        }}
      />
      <output aria-label="Responder intent">{JSON.stringify(responders)}</output>
      <button>Outside</button>
    </>
  );
}
it('preserves default/all/selected protocol intents and distinguishes no selection from defaults', () => {
  render(<Surface />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  expect(screen.getByRole('button', { name: 'Choose who replies' }).textContent).toContain(
    'Defaults',
  );
  open();
  expect(
    (screen.getByRole('checkbox', { name: 'Reviewer · on-one' }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Reviewer · on-two · Session unavailable',
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer · on-one' }));
  expect(screen.getByLabelText('Responder intent').textContent).toBe(
    '{"kind":"selected","sessionIds":[]}',
  );
  expect(screen.getByRole('button', { name: 'Choose who replies' }).textContent).toContain(
    'No agents',
  );
  fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
  expect(screen.getByLabelText('Responder intent').textContent).toBe('{"kind":"all"}');
  fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
  expect(screen.getByLabelText('Responder intent').textContent).toBe('{"kind":"default"}');
  expect((screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement).value).toBe(
    'Keep this draft',
  );
});
it('dismisses without stealing outside focus, and restores the keyboard trigger on Escape', () => {
  render(<Surface />);
  const trigger = screen.getByRole('button', { name: 'Choose who replies' });
  fireEvent.click(trigger);
  const defaults = screen.getByRole('button', { name: 'Defaults' });
  defaults.focus();
  fireEvent.keyDown(defaults, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
  fireEvent.click(trigger);
  const outside = screen.getByRole('button', { name: 'Outside' });
  outside.focus();
  fireEvent.pointerDown(outside);
  expect(document.activeElement).toBe(outside);
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
});
it('retains disappeared stable recipients and never turns their explicit intent into defaults', () => {
  const onChange = vi.fn();
  render(
    <ComposerResponders
      input={{ current: null }}
      text=""
      onTextChange={vi.fn()}
      onOpenChange={vi.fn()}
      selection={{
        members: [],
        selectedIds: ['gone'],
        responders: { kind: 'selected', sessionIds: ['gone'] },
        onChange,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  expect(screen.getByRole('checkbox', { name: 'Unavailable agent · gone' })).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});

it('allows an unavailable selected recipient to be removed without silently choosing defaults', () => {
  const onChange = vi.fn();
  render(
    <ComposerResponders
      input={{ current: null }}
      text="Keep draft"
      onTextChange={vi.fn()}
      onOpenChange={vi.fn()}
      selection={{
        members,
        selectedIds: ['session-two'],
        responders: { kind: 'selected', sessionIds: ['session-two'] },
        onChange,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  const unavailable = screen.getByRole('checkbox', {
    name: 'Reviewer · on-two · Session unavailable',
  }) as HTMLInputElement;
  expect(unavailable.disabled).toBe(false);
  fireEvent.click(unavailable);
  expect(onChange).toHaveBeenCalledWith([], { kind: 'selected', sessionIds: [] });
});
