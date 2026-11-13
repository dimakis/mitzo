// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActiveSessionsList } from '../ActiveSessionsList';
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    activities: ['a', 'b'].map((id, index) => ({
      sessionId: id,
      title: id,
      state: 'working',
      flags: [],
      lastEventAt: 200 - index * 100,
    })),
    attendCount: 0,
    connected: true,
  }),
}));
afterEach(cleanup);
it('uses the ordering queue controlled by the sidebar Show latest action', () => {
  const rows = ['b', 'a'].map((id) => ({ id, summary: id, lastModified: 1 }));
  const view = render(
    <ActiveSessionsList
      paused
      onSelectSession={vi.fn()}
      ordering={{
        sessions: rows,
        groups: new Map([
          ['a', 0],
          ['b', 0],
        ]),
      }}
    />,
  );
  expect(
    [...view.container.querySelectorAll('.cc-card-title')].map((node) => node.textContent),
  ).toEqual(['b', 'a']);
});
