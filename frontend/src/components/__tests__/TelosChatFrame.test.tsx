// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TelosChatFrame } from '../TelosChatFrame';
afterEach(cleanup);
it('closes the tree when the ordinary route switches conversations without remounting its slots', () => {
  const props = {
    itemTitle: 'Slice',
    chatCount: 2,
    onItem: vi.fn(),
    onChats: vi.fn(),
    header: <header>Ordinary header</header>,
    tree: <p>Tree</p>,
  };
  const { rerender } = render(
    <TelosChatFrame {...props} conversationId="worker">
      <textarea defaultValue="Draft" />
    </TelosChatFrame>,
  );
  const draft = screen.getByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'Toggle work tree' }));
  expect(screen.getByRole('region', { name: 'Work tree' })).toBeTruthy();
  rerender(
    <TelosChatFrame {...props} conversationId="reviewer">
      <textarea defaultValue="Draft" />
    </TelosChatFrame>,
  );
  expect(
    screen.getByRole('button', { name: 'Toggle work tree' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(screen.getByRole('textbox')).toBe(draft);
});
it('starts closed, retains the transcript and draft through toggles, and restores trigger focus', () => {
  const onChats = vi.fn(),
    onItem = vi.fn();
  render(
    <TelosChatFrame
      conversationId="worker"
      itemTitle="Contributor controls"
      chatCount={3}
      onItem={onItem}
      onChats={onChats}
      header={<header>Ordinary chat settings</header>}
      tree={<p>Selected work tree</p>}
    >
      <label>
        Message Mitzo
        <textarea defaultValue="Worker draft" />
      </label>
    </TelosChatFrame>,
  );
  const trigger = screen.getByRole('button', { name: 'Toggle work tree' });
  const draft = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('region', { name: 'Work tree' })).toBeNull();
  fireEvent.change(draft, { target: { value: 'Unsent worker draft' } });
  fireEvent.click(trigger);
  expect(screen.getByRole('region', { name: 'Work tree' })).toBeTruthy();
  expect(screen.getByRole('textbox')).toBe(draft);
  fireEvent.keyDown(screen.getByRole('region', { name: 'Work tree' }), { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(draft.value).toBe('Unsent worker draft');
  fireEvent.click(screen.getByRole('button', { name: 'Chats for this item: 3' }));
  expect(onChats).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'View item: Contributor controls' }));
  expect(onItem).toHaveBeenCalledOnce();
});
