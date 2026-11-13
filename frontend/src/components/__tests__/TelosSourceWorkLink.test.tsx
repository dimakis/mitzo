// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosSourceWorkLink } from '../TelosSourceWorkLink';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../hooks/useTelosSourceNavigation', () => ({
  useTelosSourceNavigation: () => undefined,
}));
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const context = {
  version: 1,
  itemId: 'slice',
  role: 'worker',
  leadConversationId: 'former-lead',
  brief: { revision: 'original', sha256: 'a'.repeat(64), text: 'Reviewed task' },
  parentCriteria: [],
  overallGoal: { itemId: 'feature', revision: 'original', text: 'Feature' },
  sources: [],
  artifacts: [],
};
function show(coordination: unknown) {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        sessionId: 'worker',
        telosWorkRoleContext: context,
        telosSessionCoordination: coordination,
      }),
    ),
  );
  render(
    <MemoryRouter>
      <TelosSourceWorkLink conversationId="worker" hideItemLink />
    </MemoryRouter>,
  );
}
it.each([undefined, 'TERMINAL'])(
  'returns to the currently assigned idle lead (%s)',
  async (executionPhase) => {
    show({
      itemId: 'slice',
      role: 'worker',
      assignment: 'current',
      reportingTo: {
        conversationId: 'current-lead',
        availability: 'available',
        executionPhase,
        executionTerminalReason: 'completed',
      },
      diagnostic: null,
    });
    expect(
      (await screen.findByRole('link', { name: 'Return to lead chat' })).getAttribute('href'),
    ).toBe('/chat/current-lead');
    expect(screen.getByText('Reviewed task')).toBeTruthy();
  },
);
it.each([
  undefined,
  { diagnostic: 'coordination_unavailable' },
  {
    itemId: 'other-slice',
    role: 'worker',
    assignment: 'current',
    reportingTo: { conversationId: 'wrong-lead', availability: 'available' },
  },
  {
    itemId: 'slice',
    role: 'worker',
    assignment: 'previous',
    reportingTo: { conversationId: 'new-lead', availability: 'available' },
  },
  {
    itemId: 'slice',
    role: 'worker',
    assignment: 'current',
    reportingTo: {
      conversationId: 'stopped-lead',
      availability: 'available',
      executionPhase: 'TERMINAL',
    },
    diagnostic: 'assigned_coordinator_unavailable',
  },
])(
  'shows unavailable coordination without falling back to the retained former lead (%j)',
  async (coordination) => {
    show(coordination);
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Current lead unavailable. Review the assignment in linked work.',
    );
    expect(screen.queryByRole('link', { name: 'Return to lead chat' })).toBeNull();
  },
);
