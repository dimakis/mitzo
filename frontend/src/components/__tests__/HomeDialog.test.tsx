// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

it('supports a shared full-screen variant while retaining native close, focus and scroll ownership', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const parentKey = vi.fn();
  const close = vi.fn();
  const view = render(
    <div onKeyDown={parentKey}>
      <HomeDialog title="Preview" className="fullscreen-test" onClose={close}>
        <button>Draw</button>
      </HomeDialog>
    </div>,
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog.classList.contains('home-dialog')).toBe(true);
  expect(dialog.classList.contains('fullscreen-test')).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Draw' }), { key: 'Enter' });
  expect(parentKey).not.toHaveBeenCalled();
  fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.body.style.overflow).toBe('');
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('makes a retained closing surface inert and hidden from assistive technology', () => {
  render(
    <HomeDialog title="File options" inactive onClose={() => {}}>
      <button>Share</button>
    </HomeDialog>,
  );
  const dialog = screen.getByRole('dialog', { hidden: true });
  expect(dialog.hasAttribute('inert')).toBe(true);
  expect(dialog.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
});
