// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { useTelosChatDetails } from '../useTelosChatDetails';
import { TelosChatList } from '../../components/TelosChatList';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../useSessionList', () => ({
  useSessionList: () => ({ sessions: [{ id: 'chat', summary: 'Recording implementation' }] }),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const createdAt = Date.parse('2026-10-16T10:00:00Z');
const meta = {
  sessionId: 'chat',
  createdAt,
  accountBinding: { accountLabel: 'Personal account', model: 'fixture-id' },
  modelSelection: { model: 'fixture-id', models: [{ id: 'fixture-id', label: 'Luna fixture' }] },
  agentProfile: { definition: { name: 'Independent reviewer' } },
  runtimeBinding: {
    version: 2,
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'fixture' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
  },
};
const work = TelosWorkViewSchema.parse({
  itemId: 'item',
  kind: 'work_item',
  parentId: null,
  revision: 'a'.repeat(64),
  sources: [],
  attempts: [],
  links: [
    {
      version: 1,
      linkId: 'role-link',
      itemId: 'item',
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
      linkedAt: '2026-10-20T01:13:23.803Z',
      linkedBy: 'operator:fixture-uuid',
      availability: 'available',
      attemptId: null,
    },
  ],
  assignments: [
    {
      itemId: 'item',
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
      revision: 1,
      assignedAt: null,
      assignedBy: null,
    },
  ],
});
function Fixture() {
  const details = useTelosChatDetails(work);
  return (
    <TelosChatList
      work={work}
      title="Outcome"
      details={details}
      onOpen={vi.fn()}
      onNewChat={vi.fn()}
    />
  );
}
beforeEach(() =>
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => meta } as Response),
);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('uses actual conversation creation metadata in the approved primary hierarchy and keeps immutable link provenance on request', async () => {
  render(<Fixture />);
  const opener = screen.getByRole('button', {
    name: 'Open Assigned worker: Recording implementation',
  });
  await waitFor(() =>
    expect(opener.querySelector('.telos-chat-role-settings')?.textContent).toBe(
      'Assigned worker · Personal account · Luna fixture',
    ),
  );
  expect(opener.querySelector('small')?.textContent).toBe('Assigned worker');
  expect(within(opener).getByText(/Independent reviewer · Local Mac/)).toBeTruthy();
  const time = opener.querySelector('time')!;
  expect(time.dateTime).toBe('2026-10-16T10:00:00.000Z');
  expect(time.textContent).toBe(
    `Created ${new Date(createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`,
  );
  expect(opener.textContent).not.toContain('2026-10-20T01:13:23.803Z');
  expect(opener.textContent).not.toContain('operator:fixture-uuid');
  const provenance = screen.getByText('Conversation provenance').closest('details')!;
  expect(provenance.open).toBe(false);
  expect(provenance.textContent).toContain('2026-10-20T01:13:23.803Z');
  expect(provenance.textContent).toContain('operator:fixture-uuid');
  expect(apiFetch).toHaveBeenCalledExactlyOnceWith(
    '/api/sessions/chat/meta',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(work.links[0].role).toBe('worker');
});
it.each([undefined, null, -1, Number.NaN, 8640000000000001, '2026-10-16'])(
  'keeps invalid or missing creation time unknown without losing actual settings (%s)',
  async (value) => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...meta, createdAt: value }),
    } as Response);
    render(<Fixture />);
    const opener = screen.getByRole('button', {
      name: 'Open Assigned worker: Recording implementation',
    });
    await waitFor(() =>
      expect(opener.querySelector('.telos-chat-role-settings')?.textContent).toBe(
        'Assigned worker · Personal account · Luna fixture',
      ),
    );
    expect(within(opener).getByText(/Created date unavailable/)).toBeTruthy();
    expect(opener.querySelector('time')).toBeNull();
    expect(opener.textContent).not.toContain('2026-10-20');
  },
);
it('does not use another conversation metadata identity for display or its creation date', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ...meta, sessionId: 'elsewhere' }),
  } as Response);
  render(<Fixture />);
  await waitFor(() => expect(screen.getByText('Settings unavailable')).toBeTruthy());
  expect(screen.getByText(/Created date unavailable/)).toBeTruthy();
  expect(screen.queryByText(/Luna fixture/)).toBeNull();
});
