// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { WorkspaceActionMenu } from '../WorkspaceActionMenu';
import { HomeDialog } from '../HomeDialog';
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
it('uses the shared menu, keyboard navigation and focus restoration without changing surrounding navigation', () => {
  const archive = vi.fn(),
    trash = vi.fn(),
    outer = vi.fn();
  render(
    <div onClick={outer}>
      <WorkspaceActionMenu
        label="Item actions"
        items={[
          { id: 'archive', label: 'Archive', onSelect: archive },
          { id: 'trash', label: 'Move to Trash', onSelect: trash },
        ]}
      />
    </div>,
  );
  const trigger = screen.getByRole('button', { name: 'Item actions' });
  fireEvent.click(trigger);
  expect(
    screen.getByRole('menu', { name: 'Item actions' }).classList.contains('session-context-menu'),
  ).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Archive' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move to Trash' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(outer).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
  expect(archive).toHaveBeenCalledOnce();
  expect(trash).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
it('keeps selected view semantics and refuses disabled actions', () => {
  const select = vi.fn();
  render(
    <WorkspaceActionMenu
      label="Outcome views"
      items={[
        { id: 'active', label: 'Active', checked: true, onSelect: select },
        { id: 'trash', label: 'Trash', checked: false, disabled: true, onSelect: select },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Outcome views' }));
  expect(screen.getByRole('menuitemradio', { name: 'Active' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Trash' }));
  expect(select).not.toHaveBeenCalled();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
});
it('hands modal focus back to the original action trigger after a menu selection', () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <WorkspaceActionMenu
          label="Item actions"
          items={[{ id: 'archive', label: 'Archive', onSelect: () => setOpen(true) }]}
        />
        {open && (
          <HomeDialog title="Archive item?" onClose={() => setOpen(false)}>
            <button onClick={() => setOpen(false)}>Cancel archive</button>
          </HomeDialog>
        )}
      </>
    );
  }
  render(<Example />);
  const trigger = screen.getByRole('button', { name: 'Item actions' });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
  expect(screen.getByRole('dialog', { name: 'Archive item?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel archive' }));
  expect(document.activeElement).toBe(trigger);
});
