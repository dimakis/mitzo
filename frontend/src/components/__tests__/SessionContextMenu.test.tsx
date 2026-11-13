// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SessionContextMenu } from '../SessionContextMenu';

vi.mock('../HomePinButton', () => ({
  HomePinButton: () => <button role="menuitem">Pin to Today</button>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('keeps the menu inside the viewport when an asynchronous read failure adds actions', async () => {
  let notifyResize: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal('innerHeight', 720);
  vi.stubGlobal('innerWidth', 1024);
  let height = 200;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('session-context-menu') ? height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(280);
  let rejectRead!: (cause: Error) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise((_resolve, reject) => (rejectRead = reject))),
  );
  const trigger = document.createElement('button');
  document.body.append(trigger);
  const view = render(
    <SessionContextMenu
      state={{
        session: { id: 'growing-menu', summary: 'Review UI', lastModified: 1 },
        trigger,
        point: { x: 1000, y: 400 },
      }}
      onClose={vi.fn()}
      onOpen={vi.fn()}
      onRename={vi.fn()}
      onDelete={vi.fn()}
      onHide={vi.fn()}
    />,
  );
  const menu = screen.getByRole('menu', { name: 'Session actions' });
  expect(menu.style.top).toBe('400px');
  expect(menu.style.left).toBe('736px');
  await act(async () => rejectRead(new Error('offline')));
  expect(screen.getByText('Read status unavailable. Try again.')).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Retry read status' })).toBeTruthy();
  expect(notifyResize).toBeTypeOf('function');
  height = 600;
  act(() => notifyResize!());
  expect(menu.style.top).toBe('112px');
  expect(Number.parseFloat(menu.style.top) + height).toBeLessThanOrEqual(innerHeight - 8);
  view.unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
});
