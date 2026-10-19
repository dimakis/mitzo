// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HomeDialog } from '../HomeDialog';
import { useState } from 'react';

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

it('keeps nested cancellation inside its form, including a busy dismissal guard', () => {
  const outerClose = vi.fn();
  const innerClose = vi.fn();
  const view = render(
    <HomeDialog title="Selected work" onClose={outerClose}>
      <HomeDialog title="Add contributor" onClose={innerClose}>
        <input aria-label="Contributor name" />
      </HomeDialog>
    </HomeDialog>,
  );
  fireEvent(
    screen.getByRole('dialog', { name: 'Add contributor' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(innerClose).toHaveBeenCalledOnce();
  expect(outerClose).not.toHaveBeenCalled();
  view.rerender(
    <HomeDialog title="Selected work" onClose={outerClose}>
      <HomeDialog title="Add contributor" onClose={() => {}}>
        <input aria-label="Contributor name" />
      </HomeDialog>
    </HomeDialog>,
  );
  const cancel = new Event('cancel', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('dialog', { name: 'Add contributor' }), cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(outerClose).not.toHaveBeenCalled();
  expect(screen.getAllByRole('dialog')).toHaveLength(2);
});

it('restores the original scroll state when a nested view unmounts together', () => {
  document.body.style.overflow = 'auto';
  function View() {
    const [nested, setNested] = useState(false);
    return (
      <HomeDialog title="Selected work" onClose={() => {}}>
        <button onClick={() => setNested(true)}>Keep output</button>
        {nested && (
          <HomeDialog title="Keep output" onClose={() => {}}>
            Draft
          </HomeDialog>
        )}
      </HomeDialog>
    );
  }
  const view = render(<View />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep output' }));
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
  document.body.style.overflow = '';
});

it('keeps scrolling locked until the last sibling or nested owner closes', () => {
  function View() {
    const [outer, setOuter] = useState(true);
    return (
      <>
        {outer && (
          <HomeDialog title="First" onClose={() => setOuter(false)}>
            First
          </HomeDialog>
        )}
        <HomeDialog title="Second" onClose={() => {}}>
          Second
        </HomeDialog>
      </>
    );
  }
  const view = render(<View />);
  fireEvent(
    screen.getByRole('dialog', { name: 'First' }),
    new Event('cancel', { bubbles: true, cancelable: true }),
  );
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(document.body.style.overflow).toBe('hidden');
  view.unmount();
  expect(document.body.style.overflow).toBe('');
});

it('can retain editable content while closed without keeping the modal or scroll lock active', () => {
  const onClose = vi.fn();
  const view = render(
    <HomeDialog title="Saved setup" open={false} onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  view.rerender(
    <HomeDialog title="Saved setup" open onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  const field = screen.getByRole('textbox', { name: 'Setup guidance' });
  fireEvent.change(field, { target: { value: 'Edited guidance' } });
  view.rerender(
    <HomeDialog title="Saved setup" open={false} onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  view.rerender(
    <HomeDialog title="Saved setup" open onClose={onClose}>
      <input aria-label="Setup guidance" defaultValue="Keep this" />
    </HomeDialog>,
  );
  expect(screen.getByRole('textbox', { name: 'Setup guidance' })).toBe(field);
  expect((field as HTMLInputElement).value).toBe('Edited guidance');
});

it('restores focus beyond a concealed settings editor when its summary is concealed too', () => {
  const outer = document.createElement('div');
  outer.innerHTML =
    '<button aria-controls="outer-settings">Settings</button><div id="outer-settings"><button aria-controls="field-editor">More options</button><div id="field-editor"><button>Review findings</button></div></div>';
  document.body.append(outer);
  const buttons = outer.querySelectorAll('button');
  buttons[2].focus();
  const view = render(
    <HomeDialog title="Review" onClose={() => {}}>
      Details
    </HomeDialog>,
  );
  outer.querySelector('#outer-settings')!.setAttribute('inert', '');
  outer.querySelector('#field-editor')!.setAttribute('hidden', '');
  view.unmount();
  expect(document.activeElement).toBe(buttons[0]);
  outer.remove();
});
