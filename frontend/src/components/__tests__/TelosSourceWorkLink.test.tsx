// @vitest-environment node-compatible-dom
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
it('refreshes the mounted link from the canonical assignment commit through the supported broadcaster', async () => {
  const { createTelosCanonicalData } =
    await import('../../../../server/__tests__/fixtures/telos-canonical-advisor');
  const { TelosWorkStore } = await import('../../../../server/telos-work-store');
  const { bindTelosWorkUpdateBroadcast } = await import('../../../../server/telos-work-updates');
  const f = createTelosCanonicalData();
  const work = new TelosWorkStore(f.dbPath, { ordinaryConversation: () => true });
  const assign = (id: string, revision: number) =>
    work.execute(
      {
        operation: 'setup_role',
        requestId: id,
        itemId: 'studio',
        role: 'lead',
        conversationId: id,
        expectedRevision: work.read('studio', f.actor).revision,
        expectedAssignmentRevision: revision,
      },
      f.actor,
    );
  let unbind = () => {};
  try {
    assign('first-lead', 0);
    show({
      itemId: 'slice',
      role: 'worker',
      assignment: 'current',
      reportingTo: {
        conversationId: 'first-lead',
        availability: 'available',
      },
    });
    await screen.findByRole('link', { name: 'Return to lead chat' });
    vi.mocked(apiFetch).mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            sessionId: 'worker',
            telosWorkRoleContext: context,
            telosSessionCoordination: {
              itemId: 'slice',
              role: 'worker',
              assignment: 'current',
              reportingTo: {
                conversationId: work
                  .read('studio', f.actor)
                  .assignments.find((a) => a.role === 'lead')!.conversation.conversationId,
                availability: 'available',
              },
            },
          }),
        ),
    );
    unbind = bindTelosWorkUpdateBroadcast({
      broadcast: (event) => broadcasts.events.get(event)?.(),
    });
    await act(async () => {
      assign('replacement-lead', 1);
    });
    expect(
      (await screen.findByRole('link', { name: 'Return to lead chat' })).getAttribute('href'),
    ).toBe('/chat/replacement-lead');
  } finally {
    unbind();
    work.close();
    f.close();
  }
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
