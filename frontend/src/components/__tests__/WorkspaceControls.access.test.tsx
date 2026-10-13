// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceControls } from '../WorkspaceControls';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps Access reachable alongside collapsed workspace controls', () => {
  localStorage.removeItem('mitzo-workspace-controls-expanded');
  render(
    <WorkspaceControls status="Ready" actions={<button>Access</button>}>
      <button>Account controls</button>
    </WorkspaceControls>,
  );
  expect(screen.getByRole('button', { name: 'Access' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Account controls' })).toBeNull();
});

it('reserves dynamically added repository actions before the composer while keeping the settings disclosure scrollable', async () => {
  localStorage.setItem('mitzo-workspace-controls-expanded', '1');
  let resized = () => {};
  let repositoryTop = 300;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const style = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) =>
    element.classList.contains('motion-disclosure')
      ? ({ position: 'absolute' } as CSSStyleDeclaration)
      : style(element),
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.classList.contains('repository-chat-picker')
      ? repositoryTop
      : this.classList.contains('chat-input')
        ? 600
        : 0;
    const bottom = this.classList.contains('workspace-controls') ? 100 : top;
    return {
      top,
      bottom,
      left: 0,
      right: 320,
      width: 320,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  function Layout({ repository }: { repository: boolean }) {
    return (
      <div className="workspace-chat">
        <WorkspaceControls status="Needs review">
          <button>Settings last action</button>
        </WorkspaceControls>
        {repository && (
          <section className="repository-chat-picker">
            <button>Add repository</button>
          </section>
        )}
        <div className="chat-input" />
      </div>
    );
  }
  const { container, rerender } = render(<Layout repository={false} />);
  const disclosure = container.querySelector<HTMLElement>('.motion-disclosure')!;
  expect(disclosure.style.getPropertyValue('--workspace-disclosure-space')).toBe('500px');
  const control = screen.getByRole('button', { name: 'Settings last action' });
  control.focus();
  rerender(<Layout repository />);
  await waitFor(() =>
    expect(disclosure.style.getPropertyValue('--workspace-disclosure-space')).toBe('200px'),
  );
  expect(document.activeElement).toBe(control);
  expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy();
  repositoryTop = 250;
  act(() => resized());
  expect(disclosure.style.getPropertyValue('--workspace-disclosure-space')).toBe('150px');
  rerender(<Layout repository={false} />);
  await waitFor(() =>
    expect(disclosure.style.getPropertyValue('--workspace-disclosure-space')).toBe('500px'),
  );
  expect(document.activeElement).toBe(control);
});
