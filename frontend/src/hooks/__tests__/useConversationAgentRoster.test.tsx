// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useConversationAgentRoster } from '../useConversationAgentRoster';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';
vi.mock('../useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [], connected: false }),
}));
afterEach(cleanup);
it('retains display knowledge through missing observations but clears it across source or login owners', () => {
  const owner = {};
  const view = sharedConversationView();
  const { result, rerender } = renderHook(
    ({ owner, view }) =>
      useConversationAgentRoster(owner, { view, needsRefresh: false, eventIds: {} }, {}),
    { initialProps: { owner, view } },
  );
  expect(result.current[1].model).toBe('offline-fixture');
  const missing = { ...view, messages: [] };
  rerender({ owner, view: missing });
  expect(result.current[1].model).toBe('offline-fixture');
  rerender({ owner: {}, view: missing });
  expect(result.current[1].model).toBeUndefined();
  expect(result.current[1].profile).toBeUndefined();
  expect(result.current[1].state).toBe('Not observed');
});
