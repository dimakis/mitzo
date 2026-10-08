// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SeatLabel } from '../SeatLabel';
import { SymposiumPerspectiveTabs } from '../SymposiumPerspectiveTabs';
afterEach(cleanup);
it('keeps the same seat accent across its named tab, renamed label, and roster reorder', () => {
  const seats = [
    { id: 'seat-a', name: 'Analyst' },
    { id: 'seat-b', name: 'Writer' },
  ];
  const { rerender } = render(
    <>
      <SymposiumPerspectiveTabs seats={seats} selected="seat-a" onSelect={vi.fn()} />
      <SeatLabel seatId="seat-a" name="Historic Analyst" />
    </>,
  );
  const tab = screen.getByRole('tab', { name: 'Analyst' });
  const color = tab.querySelector('[data-seat-accent]')?.getAttribute('style');
  expect(color).toBeTruthy();
  expect(
    screen.getByText('Historic Analyst').querySelector('[data-seat-accent]')?.getAttribute('style'),
  ).toBe(color);
  rerender(
    <>
      <SymposiumPerspectiveTabs
        seats={[seats[1], { ...seats[0], name: 'New Analyst' }]}
        selected="seat-a"
        onSelect={vi.fn()}
      />
      <SeatLabel seatId="seat-a" name="Historic Analyst" />
    </>,
  );
  expect(
    screen
      .getByRole('tab', { name: 'New Analyst' })
      .querySelector('[data-seat-accent]')
      ?.getAttribute('style'),
  ).toBe(color);
  expect(screen.getByRole('tab', { name: 'All' }).querySelector('[data-seat-accent]')).toBeNull();
});
