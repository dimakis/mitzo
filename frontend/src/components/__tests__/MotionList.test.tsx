// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotionList } from '../MotionList';

let reduced = false;
const listeners = new Set<() => void>();
const animations: { cancel: ReturnType<typeof vi.fn>; finish: () => void }[] = [];
const animate = vi.fn();
beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  document.documentElement.style.setProperty('--motion-duration-standard', '200ms');
  document.documentElement.style.setProperty('--motion-duration-reorder', '1100ms');
  document.documentElement.style.setProperty('--motion-ease', 'linear');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.dataset.motionKey
      ? [...this.parentElement!.children].indexOf(this) * 60 -
        (this.closest('.session-list-scroll')?.scrollTop ?? 0)
      : 0;
    return {
      top,
      bottom: top + 60,
      left: 0,
      right: 300,
      width: 300,
      height: 60,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  animate.mockImplementation(() => {
    let finish!: () => void;
    const animation = {
      cancel: vi.fn(),
      finished: new Promise<void>((r) => {
        finish = r;
      }),
    };
    animations.push({ cancel: animation.cancel, finish });
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  listeners.clear();
  animations.length = 0;
  animate.mockReset();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});
function list(ids: string[]) {
  return (
    <MotionList className="rows">
      {ids.map((id) => (
        <div key={id} data-motion-key={id}>
          <input aria-label={id} defaultValue="Draft" />
        </div>
      ))}
    </MotionList>
  );
}
it('slides keyed rows from their old positions without remounting or replaying on status renders', () => {
  const view = render(list(['a', 'b']));
  const input = screen.getByLabelText('b');
  input.focus();
  expect(animate).not.toHaveBeenCalled();
  view.rerender(list(['b', 'a']));
  expect(screen.getByLabelText('b')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(animate.mock.calls[0][0]).toEqual([
    { translate: '0 60px', zIndex: '1' },
    { translate: '0 0', zIndex: '1' },
  ]);
  expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1100, easing: 'linear' });
  view.rerender(list(['b', 'a']));
  expect(animate).toHaveBeenCalledTimes(2);
});
it('cancels interrupted moves, reduced-motion changes and unmounted animations', async () => {
  const view = render(list(['a', 'b']));
  view.rerender(list(['b', 'a']));
  view.rerender(list(['a', 'b']));
  expect(animations[0].cancel).toHaveBeenCalled();
  act(() => {
    reduced = true;
    listeners.forEach((fn) => fn());
  });
  expect(animations.every((a) => a.cancel.mock.calls.length)).toBe(true);
  const count = animate.mock.calls.length;
  view.rerender(list(['b', 'a']));
  expect(animate).toHaveBeenCalledTimes(count);
  act(() => {
    reduced = false;
    listeners.forEach((fn) => fn());
  });
  view.rerender(list(['a', 'b']));
  view.unmount();
  expect(animations.every((a) => a.cancel.mock.calls.length)).toBe(true);
});

it('keeps the first visible conversation anchored while another row rises above it', () => {
  const surface = (ids: string[]) => (
    <div className="session-list-scroll" data-testid="scroller">
      {list(ids)}
    </div>
  );
  const view = render(surface(['a', 'b', 'c']));
  const scroller = screen.getByTestId('scroller');
  scroller.scrollTop = 60;
  const before = screen.getByLabelText('b').parentElement!.getBoundingClientRect().top;
  view.rerender(surface(['c', 'a', 'b']));
  expect(scroller.scrollTop).toBe(120);
  expect(screen.getByLabelText('b').parentElement!.getBoundingClientRect().top).toBe(before);
});
