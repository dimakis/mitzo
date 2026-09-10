// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { eventBus } from '../../lib/event-bus-singleton';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn() }) }));

it('starts fixture activity events when the preview bypasses login restoration', async () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  const unsubscribe = eventBus.on('session_activity', listener);
  try {
    await import('../main');
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ state: 'waiting', waitReason: 'review' })]),
    );
  } finally {
    unsubscribe();
    eventBus.disconnect();
    vi.useRealTimers();
  }
});
