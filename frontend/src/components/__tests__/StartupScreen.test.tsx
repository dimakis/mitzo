// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartupScreen } from '../StartupScreen';
vi.mock('../LiquidLogo', () => ({ LiquidLogo: () => <div data-testid="liquid-logo" /> }));
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('retains the selected phrase and quote through connection retries', () => {
  const retry = vi.fn();
  const view = render(<StartupScreen state="loading" onRetry={retry} />);
  const phrase = screen.getByTestId('startup-phrase').textContent;
  act(() => {
    vi.advanceTimersByTime(2500);
  });
  const quote = screen.getByRole('blockquote').textContent;
  view.rerender(<StartupScreen state="unavailable" onRetry={retry} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  view.rerender(<StartupScreen state="loading" onRetry={retry} />);
  expect(screen.getByTestId('startup-phrase').textContent).toBe(phrase);
  expect(screen.getByRole('blockquote').textContent).toBe(quote);
});
it('never forces a ready app to wait for the animation or quote', () => {
  const view = render(<StartupScreen state="loading" onRetry={() => {}} />);
  view.rerender(<StartupScreen state="ready" onRetry={() => {}} />);
  expect(screen.queryByTestId('startup-screen')).toBeNull();
});
it('does not replay an entrance for an already verified route', () => {
  render(<StartupScreen state="ready" onRetry={() => {}} />);
  expect(screen.queryByTestId('startup-screen')).toBeNull();
});
