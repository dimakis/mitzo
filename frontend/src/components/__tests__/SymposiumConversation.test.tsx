// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumConversation } from '../SymposiumConversation';
import { SymposiumProfileProposals } from '../SymposiumProfileProposals';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../ChatArea', () => ({
  ChatArea: ({
    messages,
    contextItems = [],
    onShareMessage,
  }: {
    messages: { messageId: string; symposiumProvenance?: { membershipGeneration: number } }[];
    contextItems?: { deliveryId: string; receipt: string }[];
    onShareMessage?: (messageId: string, provenance?: { membershipGeneration: number }) => void;
  }) => (
    <div data-testid="rich-chat">
      {messages.map((message) => (
        <div key={message.messageId}>
          {message.messageId}
          {onShareMessage && (
            <button onClick={() => onShareMessage(message.messageId, message.symposiumProvenance)}>
              Share excerpt
            </button>
          )}
        </div>
      ))}
      {contextItems.map((item) => (
        <div key={item.deliveryId}>
          {item.deliveryId}:{item.receipt}
        </div>
      ))}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const status = {
  sessionId: 'session',
  config: { version: 2, revision: 2, state: 'active' },
  seats: [
    { seatId: 'architect', seat: { name: 'Architect' }, admitted: true },
    { seatId: 'reviewer', seat: { name: 'Reviewer' }, admitted: true },
  ],
};
const page = {
  items: [
    {
      kind: 'authored',
      eventSeq: 3,
      messageId: 'architect-reply',
      seatId: 'architect',
      content: 'Plan',
      provenance: null,
    },
    {
      kind: 'recipient-input',
      eventSeq: 4,
      deliveryId: 'd1',
      attemptId: 1,
      recipientSeatId: 'reviewer',
      sourceSeatId: 'architect',
      sourceMessageId: 'architect-reply',
      content: 'Plan',
      receipt: 'received',
      recipientStatus: 'executing',
    },
    {
      kind: 'authored',
      eventSeq: 5,
      messageId: 'reviewer-reply',
      seatId: 'reviewer',
      content: 'Reviewed',
      provenance: null,
    },
  ],
  nextSeq: null,
  queued: [
    {
      deliveryId: 'd2',
      recipientSeatId: 'reviewer',
      proposedContent: 'Later',
      deliveryStatus: 'staged',
    },
  ],
};
const json = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
const chat = {
  messages: [
    {
      messageId: 'architect-reply',
      role: 'assistant' as const,
      blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'Plan' }],
    },
    {
      messageId: 'reviewer-reply',
      role: 'assistant' as const,
      blocks: [{ blockId: 'b2', blockType: 'text' as const, content: 'Reviewed' }],
    },
  ],
  current: null,
  currentByMessage: {},
  running: false,
  permission: null,
  onPermissionRespond: vi.fn(),
};

describe('SymposiumConversation', () => {
  it('reviews a fake agent tool proposal in an ordinary existing conversation before saving', async () => {
    const proposal = {
      proposalId: 'proposal-1',
      suggestedProfileId: 'build-agent',
      state: 'pending',
      definition: {
        name: 'Build Agent',
        role: 'coder',
        instructions: 'Implement reviewed changes',
        expectedOutput: 'Patch',
        acceptanceCriteria: ['Focused checks pass'],
        modelPolicyRole: 'coder',
      },
    };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/profile-proposals') && !init?.method) return json([proposal]);
      if (String(url) === '/api/symposium/profiles') return json([]);
      if (String(url).includes('/profile-proposals/') && init?.method === 'POST')
        return json({ profileId: 'build-agent', revision: 1 });
      return json({ sessionId: 'session', config: null, seats: [] });
    });
    render(
      <SymposiumConversation
        sessionId="session"
        chat={chat}
        ordinaryComposer={<button>Ordinary send</button>}
      />,
    );
    const instructions = await screen.findByRole('textbox', { name: 'Instructions' });
    expect(screen.getByText('Ordinary send')).toBeTruthy();
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([url, init]) => String(url).includes('/profile-proposals/') && init?.method === 'POST',
        ),
    ).toBe(false);
    fireEvent.change(instructions, {
      target: { value: 'Implement reviewed changes and report checks' },
    });
    const saveButton = screen.getByRole('button', { name: 'Save reusable profile' });
    await waitFor(() => expect(saveButton.hasAttribute('disabled')).toBe(false));
    fireEvent.click(saveButton);
    await waitFor(
      () =>
        expect(
          vi
            .mocked(apiFetch)
            .mock.calls.some(
              ([url, init]) => String(url).endsWith('/proposal-1/save') && init?.method === 'POST',
            ),
        ).toBe(true),
      { timeout: 3000 },
    );
    const save = vi
      .mocked(apiFetch)
      .mock.calls.find(([url]) => String(url).endsWith('/proposal-1/save'))!;
    expect(JSON.parse(String(save[1]?.body))).toMatchObject({
      sessionId: 'session',
      profileId: 'build-agent',
      expectedRevision: 0,
      definition: { instructions: 'Implement reviewed changes and report checks' },
    });
  });

  it('keeps a proposed edit pinned to the catalog revision after a save conflict', async () => {
    const proposal = {
      proposalId: 'draft',
      suggestedProfileId: 'reviewer',
      state: 'pending',
      definition: {
        name: 'Reviewer',
        role: 'reviewer',
        instructions: 'Review patches',
        expectedOutput: 'Findings',
        acceptanceCriteria: ['Specific findings'],
        modelPolicyRole: 'reviewer',
      },
    };
    let catalogReads = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/profile-proposals') && !init?.method) return json([proposal]);
      if (String(url) === '/api/symposium/profiles') {
        catalogReads += 1;
        return json([{ profileId: 'reviewer', revision: catalogReads === 1 ? 2 : 3 }]);
      }
      if (String(url).endsWith('/draft/save'))
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'Profile revision conflict' }),
        } as Response;
      return json({ sessionId: 'session', config: null, seats: [] });
    });
    render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
    const save = await screen.findByRole('button', { name: 'Save reusable profile' });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Profile revision conflict',
    );
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/draft/save')),
      ).toHaveLength(2),
    );
    expect(catalogReads).toBe(1);
    for (const [, init] of vi
      .mocked(apiFetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/draft/save')))
      expect(JSON.parse(String(init?.body)).expectedRevision).toBe(2);
  });

  it('does not add drafting guidance to an untouched ordinary conversation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      json(
        String(url).includes('/profile-proposals')
          ? []
          : { sessionId: 'session', config: null, seats: [] },
      ),
    );
    render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
    await waitFor(() =>
      expect(
        vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/profile-proposals')),
      ).toBe(true),
    );
    expect(screen.queryByText(/Codex-backed agent/)).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Reusable profile drafts' })).toBeNull();
  });

  it('reuses a seat draft save key when retrying an uncertain response', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/profile-proposals') && !init?.method) return json([]);
      if (String(url) === '/api/symposium/profiles' && !init?.method) return json([]);
      if (String(url) === '/api/symposium/profiles' && init?.method)
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Response unavailable' }),
        } as Response;
      return json({});
    });
    render(
      <SymposiumProfileProposals
        sessionId="session"
        seatSeed={{ seatId: 'coder', name: 'Coder', role: 'coder' }}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile ID' }), {
      target: { value: 'coder' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Implement patches' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Expected output' }), {
      target: { value: 'Patch' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Acceptance criteria' }), {
      target: { value: 'Checks pass' },
    });
    const save = screen.getByRole('button', { name: 'Save reusable profile' });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Response unavailable');
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter(
            ([url, init]) => String(url) === '/api/symposium/profiles' && init?.method === 'POST',
          ),
      ).toHaveLength(2),
    );
    const bodies = vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) => String(url) === '/api/symposium/profiles' && init?.method === 'POST',
      )
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    expect(bodies[0].expectedRevision).toBe(0);
  });

  it('starts a seat profile draft without copying session instructions', async () => {
    const statusWithSeat = {
      ...status,
      seats: status.seats.map((entry) =>
        entry.seatId === 'architect'
          ? {
              ...entry,
              seat: {
                name: 'Architect',
                role: 'architect',
                systemPrompt: 'Read /Users/person/private/secret',
              },
            }
          : { ...entry, seat: { ...entry.seat, role: 'reviewer' } },
      ),
    };
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      json(
        String(url).includes('/profile-proposals')
          ? []
          : String(url).includes('/perspectives')
            ? page
            : statusWithSeat,
      ),
    );
    render(
      <SymposiumConversation
        sessionId="session"
        chat={chat}
        ordinaryComposer={<button>Ordinary send</button>}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Draft reusable profile from this seat' }),
    );
    expect(
      (screen.getByRole('textbox', { name: 'Instructions' }) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(screen.queryByText(/Read \/Users\/person/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Save reusable profile' }).hasAttribute('disabled'),
    ).toBe(true);
  });
  it('holds ordinary send until session status is known', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <SymposiumConversation
        sessionId="session"
        chat={chat}
        ordinaryComposer={<button>Ordinary send</button>}
      />,
    );
    expect(screen.queryByText('Ordinary send')).toBeNull();
    finish(json({ sessionId: 'session', config: null, seats: [] }));
    expect(await screen.findByText('Ordinary send')).toBeTruthy();
  });

  it('shows durable received context and only the selected seat reply while keeping queued input separate', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      json(String(url).includes('/perspectives') ? page : status),
    );
    render(
      <SymposiumConversation
        sessionId="session"
        chat={chat}
        ordinaryComposer={<button>Ordinary send</button>}
      />,
    );
    expect(await screen.findByRole('tab', { name: 'Reviewer' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
    await waitFor(() => expect(screen.getByText('d1:received')).toBeTruthy());
    expect(screen.getByText('reviewer-reply')).toBeTruthy();
    expect(screen.queryByText('architect-reply')).toBeNull();
    expect(screen.getByText(/Later \(staged\)/)).toBeTruthy();
    expect(screen.queryByText('Ordinary send')).toBeNull();
  });

  it('retains independent uncertain audience requests and releases only confirmed keys', async () => {
    const bodies: { idempotencyKey: string; recipientSeatIds: string[] }[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length <= 2) throw new Error('Response lost');
        return json({});
      }
      return json(
        String(url).includes('/profile-proposals')
          ? []
          : String(url).includes('/perspectives')
            ? page
            : status,
      );
    });
    render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
    const send = async (seat: string) => {
      fireEvent.click(await screen.findByRole('tab', { name: seat }));
      fireEvent.change(screen.getByRole('textbox', { name: `Message for ${seat}` }), {
        target: { value: 'Hello' },
      });
      const button = screen.getByRole('button', { name: 'Queue for approval' });
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
      fireEvent.click(button);
    };
    await send('Architect');
    await screen.findByText('Response lost');
    await send('Reviewer');
    await waitFor(() => expect(bodies).toHaveLength(2));
    await send('Architect');
    await waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    await send('Reviewer');
    await waitFor(() => expect(bodies).toHaveLength(4));
    expect(bodies[3].idempotencyKey).toBe(bodies[1].idempotencyKey);
    await send('Architect');
    await waitFor(() => expect(bodies).toHaveLength(5));
    expect(bodies[4].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
  });

  it('retains excerpt keys across edits, clears confirmed keys, and isolates sessions', async () => {
    const bodies: { idempotencyKey: string; excerpt: string }[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/share-excerpt') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        if (bodies.length <= 2) throw new Error('Response lost');
        return json({});
      }
      return json(
        String(url).includes('/profile-proposals')
          ? []
          : String(url).includes('/perspectives')
            ? page
            : { ...status, sessionId: String(url).includes('/other/') ? 'other' : 'session' },
      );
    });
    const view = render(
      <SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />,
    );
    const openShare = async () => {
      fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Share excerpt' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
    };
    const send = async (excerpt: string, count: number) => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Excerpt to share' }), {
        target: { value: excerpt },
      });
      const button = screen.getByRole('button', { name: 'Queue excerpt for approval' });
      await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
      fireEvent.click(button);
      await waitFor(() => expect(bodies).toHaveLength(count));
    };
    await openShare();
    await send('Plan', 1);
    await send('Plan'.slice(0, 2), 2);
    await send('Plan', 3);
    expect(bodies[2].idempotencyKey).toBe(bodies[0].idempotencyKey);
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Excerpt to share' })).toBeNull(),
    );
    await openShare();
    await send('Plan', 4);
    expect(bodies[3].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    view.rerender(<SymposiumConversation sessionId="other" chat={chat} ordinaryComposer={null} />);
    await openShare();
    await send('Pl', 5);
    expect(bodies[4].idempotencyKey).not.toBe(bodies[1].idempotencyKey);
  });

  it('shares the selected seat source with its membership generation', async () => {
    const versionedPage = {
      ...page,
      items: page.items.map((item) =>
        item.kind === 'authored' && item.seatId === 'architect'
          ? { ...item, provenance: { seatId: 'architect', membershipGeneration: 7 } }
          : item,
      ),
    };
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      json(String(url).includes('/perspectives') ? versionedPage : status),
    );
    render(
      <SymposiumConversation
        sessionId="session"
        chat={chat}
        ordinaryComposer={<button>Ordinary send</button>}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    await screen.findByText('architect-reply');
    fireEvent.click(screen.getByRole('button', { name: 'Share excerpt' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
    await waitFor(() =>
      expect(
        vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/share-excerpt')),
      ).toBe(true),
    );
    const call = vi
      .mocked(apiFetch)
      .mock.calls.find(([url]) => String(url).endsWith('/share-excerpt'))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      sourceSeatId: 'architect',
      sourceMessageId: 'architect-reply',
      sourceMembershipGeneration: 7,
      recipientSeatIds: ['reviewer'],
    });
  });
});
