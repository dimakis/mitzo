// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useListBrowsing } from '../useListBrowsing';
function List({ blocked = false }) {
  const ref = useRef<HTMLDivElement>(null);
  const paused = useListBrowsing(ref, blocked);
  return (
    <div ref={ref} data-testid="list">
      <output>{paused ? 'Paused' : 'Live'}</output>
      <button>Row</button>
      <input aria-label="Rename" />
    </div>
  );
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const tick = () => act(() => vi.advanceTimersByTime(1100));
it('pauses through scrolling, a held pointer and the idle interval after release outside the list', () => {
  render(<List />);
  fireEvent.scroll(screen.getByTestId('list'));
  expect(screen.getByText('Paused')).toBeTruthy();
  tick();
  expect(screen.getByText('Live')).toBeTruthy();
  fireEvent.pointerDown(screen.getByText('Row'), { pointerId: 1 });
  tick();
  expect(screen.getByText('Paused')).toBeTruthy();
  fireEvent.pointerUp(document, { pointerId: 1 });
  tick();
  expect(screen.getByText('Live')).toBeTruthy();
});
it('holds keyboard focus and editing until focus leaves, without trapping mouse-selected rows', () => {
  render(<List />);
  fireEvent.keyDown(document, { key: 'Tab' });
  act(() => screen.getByText('Row').focus());
  tick();
  expect(screen.getByText('Paused')).toBeTruthy();
  act(() => screen.getByText('Row').blur());
  tick();
  expect(screen.getByText('Live')).toBeTruthy();
  fireEvent.pointerDown(screen.getByText('Row'));
  act(() => screen.getByText('Row').focus());
  fireEvent.pointerUp(document);
  tick();
  expect(screen.getByText('Live')).toBeTruthy();
  act(() => screen.getByLabelText('Rename').focus());
  tick();
  expect(screen.getByText('Paused')).toBeTruthy();
});
it('holds an open menu or modal and clears timers on unmount', () => {
  const view = render(<List blocked />);
  expect(screen.getByText('Paused')).toBeTruthy();
  view.rerender(<List />);
  fireEvent.wheel(screen.getByTestId('list'));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
