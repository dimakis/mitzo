// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SymposiumPerspectiveTabs } from '../SymposiumPerspectiveTabs';

afterEach(cleanup);
const seats = [
  { id: 'architect', name: 'Architect' },
  { id: 'reviewer', name: 'Reviewer' },
];

it('offers tappable and keyboard-accessible All and seat tabs', async () => {
  const onSelect = vi.fn();
  render(<SymposiumPerspectiveTabs seats={seats} selected="all" onSelect={onSelect} />);
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
  await userEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
  expect(onSelect).toHaveBeenCalledWith('reviewer');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'All' }), { key: 'ArrowRight' });
  expect(onSelect).toHaveBeenCalledWith('architect');
});

it('swipes across a transcript without stealing edge-back or vertical scroll', () => {
  const onSelect = vi.fn();
  render(
    <SymposiumPerspectiveTabs seats={seats} selected="all" onSelect={onSelect}>
      <div data-testid="surface">Transcript</div>
    </SymposiumPerspectiveTabs>,
  );
  const surface = screen.getByTestId('surface');
  fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 150 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 110, clientY: 158 }] });
  expect(onSelect).toHaveBeenCalledWith('architect');
  onSelect.mockClear();
  fireEvent.touchStart(surface, { touches: [{ clientX: 8, clientY: 150 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 110, clientY: 150 }] });
  fireEvent.touchStart(surface, { touches: [{ clientX: 200, clientY: 150 }] });
  fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 130, clientY: 280 }] });
  expect(onSelect).not.toHaveBeenCalled();
});
