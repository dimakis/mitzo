// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useStableSessionOrder } from '../useStableSessionOrder';

afterEach(cleanup);

it('keeps observed chronology across status timestamps, refreshes and history hydration', () => {
  const { result, rerender } = renderHook(({ sessions }) => useStableSessionOrder(sessions), {
    initialProps: {
      sessions: [
        { id: 'old', summary: 'Older', lastModified: 10 },
        { id: 'live', summary: 'Live', lastModified: 30 },
        { id: 'recent', summary: 'Recent', lastModified: 20 },
      ],
    },
  });
  expect(result.current.map((s) => s.id)).toEqual(['live', 'recent', 'old']);
  rerender({
    sessions: [
      { id: 'old', summary: 'Renamed', lastModified: 1000 },
      { id: 'recent', summary: 'Recent', lastModified: 2000 },
      { id: 'live', summary: 'History loaded', lastModified: 5 },
    ],
  });
  expect(result.current.map((s) => s.id)).toEqual(['live', 'recent', 'old']);
  expect(result.current[2].summary).toBe('Renamed');
});

it('inserts new chats and older pages chronologically, retaining order after temporary removal', () => {
  const { result, rerender } = renderHook(({ sessions }) => useStableSessionOrder(sessions), {
    initialProps: { sessions: [{ id: 'existing', summary: '', lastModified: 20 }] },
  });
  rerender({
    sessions: [
      { id: 'existing', summary: '', lastModified: 2000 },
      { id: 'new', summary: '', lastModified: 30 },
      { id: 'page-two', summary: '', lastModified: 10 },
    ],
  });
  expect(result.current.map((s) => s.id)).toEqual(['new', 'existing', 'page-two']);
  rerender({ sessions: [{ id: 'new', summary: '', lastModified: 3000 }] });
  rerender({
    sessions: [
      { id: 'page-two', summary: '', lastModified: 9000 },
      { id: 'new', summary: '', lastModified: 3000 },
      { id: 'existing', summary: '', lastModified: 4000 },
    ],
  });
  expect(result.current.map((s) => s.id)).toEqual(['new', 'existing', 'page-two']);
});
