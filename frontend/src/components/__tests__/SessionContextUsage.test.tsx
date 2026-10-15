// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SessionContextUsage } from '../SessionContextUsage';
afterEach(cleanup);
it('renders measured occupancy rather than cumulative session tokens', () => {
  render(
    <SessionContextUsage
      usage={{
        used: 48000,
        measuredAt: 1,
        limits: { model: 'example', source: 'runtime', contextWindow: 200000, stale: false },
      }}
    />,
  );
  expect(screen.getByText(/24%/)).toBeTruthy();
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('24');
});
it('keeps missing and expired capacity explicit without a fake percentage', () => {
  const view = render(
    <SessionContextUsage
      usage={{
        used: 48000,
        measuredAt: 1,
        limits: { model: 'example', source: 'runtime', contextWindow: 200000, stale: true },
      }}
    />,
  );
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.getByText(/limit not reported/)).toBeTruthy();
  view.rerender(<SessionContextUsage />);
  expect(screen.getByText('Context unavailable')).toBeTruthy();
});
