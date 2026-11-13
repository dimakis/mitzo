// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosSourceWorkLink } from '../TelosSourceWorkLink';
import { apiFetch } from '../../lib/api-fetch';
const broadcasts = vi.hoisted(() => ({
  events: new Map<string, () => void>(),
  connections: new Set<(connected: boolean) => void>(),
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (name: string, listener: () => void) => {
      broadcasts.events.set(name, listener);
      return () => broadcasts.events.delete(name);
    },
    onConnectionChange: (listener: (connected: boolean) => void) => {
      broadcasts.connections.add(listener);
      return () => broadcasts.connections.delete(listener);
    },
  },
}));
vi.mock('../../hooks/useTelosSourceNavigation', () => ({
  useTelosSourceNavigation: () => undefined,
}));
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
  vi.clearAllMocks();
});
it.each(['todo_update', 'sessions_changed', 'reconnect'])(
  'refreshes canonical reporting on %s and hides the stale lead until the read settles',
  async (event) => {
    show({
      itemId: 'slice',
      role: 'worker',
      assignment: 'current',
      reportingTo: { conversationId: 'first-lead', availability: 'available' },
    });
    expect(
      (await screen.findByRole('link', { name: 'Return to lead chat' })).getAttribute('href'),
    ).toBe('/chat/first-lead');
    let settle!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
    );
    act(() => {
      if (event === 'reconnect') broadcasts.connections.forEach((listener) => listener(true));
      else broadcasts.events.get(event)?.();
    });
    expect(screen.queryByRole('link', { name: 'Return to lead chat' })).toBeNull();
    await act(async () =>
      settle(
        new Response(
          JSON.stringify({
            sessionId: 'worker',
            telosWorkRoleContext: context,
            telosSessionCoordination: {
              itemId: 'slice',
              role: 'worker',
              assignment: 'current',
              reportingTo: { conversationId: 'replacement-lead', availability: 'available' },
            },
          }),
        ),
      ),
    );
    expect(
      (await screen.findByRole('link', { name: 'Return to lead chat' })).getAttribute('href'),
    ).toBe('/chat/replacement-lead');
  },
);
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
