// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionDetails } from '../MotionDetails';

let reduced = false;
const listeners = new Set<() => void>();
const animations: {
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
  fail: (cause: unknown) => void;
}[] = [];
beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name.includes('duration') ? '200ms' : 'ease-out'),
  }));
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: () => {
      let finish!: () => void;
      let fail!: (cause: unknown) => void;
      const animation = {
        cancel: vi.fn(),
        finished: new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
      };
      animations.push({ cancel: animation.cancel, finish, fail });
      return animation;
    },
  });
});
afterEach(() => {
  cleanup();
  animations.length = 0;
  listeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

it('retains the closing frame, disables hidden controls immediately and restores summary focus', async () => {
  const view = render(
    <MotionDetails summary="Drafts">
      <input aria-label="Unsent draft" defaultValue="Keep me" />
    </MotionDetails>,
  );
  const summary = screen.getByText('Drafts');
  expect(summary.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(summary);
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(summary.closest('details')!.open).toBe(true);
  expect(summary.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(summary);
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => animations.at(-1)!.finish());
  expect(summary.closest('details')!.open).toBe(false);
  fireEvent.click(summary);
  expect(screen.getByRole('textbox')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Keep me');
  view.unmount();
  expect(animations.at(-1)!.cancel).toHaveBeenCalled();
});

it('cancels an interrupted close and does not replay motion as content updates', async () => {
  const view = render(
    <MotionDetails summary="Details">
      <p>First update</p>
    </MotionDetails>,
  );
  const summary = screen.getByText('Details');
  fireEvent.click(summary);
  view.rerender(
    <MotionDetails summary="Details">
      <p>Next update</p>
    </MotionDetails>,
  );
  expect(animations).toHaveLength(1);
  fireEvent.click(summary);
  const closing = animations.at(-1)!;
  fireEvent.click(summary);
  expect(closing.cancel).toHaveBeenCalled();
  await act(async () => closing.finish());
  expect(summary.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Next update').closest('[hidden]')).toBeNull();
});

it('closes immediately when Reduce Motion changes during an exit', () => {
  render(
    <MotionDetails summary="Details" defaultOpen>
      <p>Content</p>
    </MotionDetails>,
  );
  const summary = screen.getByText('Details');
  expect(animations).toHaveLength(0);
  fireEvent.click(summary);
  act(() => {
    reduced = true;
    listeners.forEach((listener) => listener());
  });
  expect(summary.closest('details')!.open).toBe(false);
  expect(animations[0].cancel).toHaveBeenCalled();
});

it('finishes a failed close and reports its stage without logging private content', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  render(
    <MotionDetails summary="Details" defaultOpen>
      <p>Private content</p>
    </MotionDetails>,
  );
  const summary = screen.getByText('Details');
  fireEvent.click(summary);
  await act(async () => animations.at(-1)!.fail(new Error('Private animation payload')));
  expect(summary.closest('details')!.open).toBe(false);
  expect(warn).toHaveBeenCalledWith(
    'UI motion could not complete',
    expect.objectContaining({
      code: 'ui_motion_failed',
      stage: 'presence',
      kind: 'disclosure',
      cause: 'Error',
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('Private');
});

it('keeps disclosure controls usable when the browser has no animation API', () => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  render(
    <MotionDetails summary="Details">
      <button>Retained action</button>
    </MotionDetails>,
  );
  const summary = screen.getByText('Details');
  fireEvent.click(summary);
  expect(screen.getByRole('button', { name: 'Retained action' })).toBeTruthy();
  fireEvent.click(summary);
  expect(summary.closest('details')!.open).toBe(false);
});
