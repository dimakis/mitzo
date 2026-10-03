// @vitest-environment jsdom
import {
  symposiumQueueOperations,
  symposiumExcerptOperations,
} from '../../lib/symposium-queue-operations';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  createSymposiumDeliveryActions,
  getSymposiumDeliveryActions,
} from '../../lib/symposium-delivery-actions';
import { apiFetch } from '../../lib/api-fetch';
import { ResponsiveChatView } from '../ResponsiveChatView';
import { SymposiumConversation } from '../SymposiumConversation';
import { SymposiumProfileProposals } from '../SymposiumProfileProposals';

const navigation = vi.hoisted(() => ({ active: 'session' }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: { sessions: { active: string } }) => unknown) =>
    select({ sessions: { active: navigation.active } }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => false }));
vi.mock('../../pages/ChatView', () => ({
  ChatView: () => (
    <SymposiumConversation sessionId={navigation.active} chat={chat} ordinaryComposer={null} />
  ),
}));
vi.mock('../../pages/DesktopChatView', () => ({ DesktopChatView: () => null }));

vi.mock('../../lib/symposium-delivery-actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/symposium-delivery-actions')>();
  return { ...actual, getSymposiumDeliveryActions: vi.fn() };
});
beforeEach(() => {
  vi.mocked(getSymposiumDeliveryActions).mockReturnValue(createSymposiumDeliveryActions());
});

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../ChatArea', () => ({
  ChatArea: ({
    messages,
    contextItems = [],
    onShareMessage,
    afterMessages,
  }: {
    afterMessages?: import('react').ReactNode;
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
      {afterMessages}
      {contextItems.map((item) => (
        <div key={item.deliveryId}>
          {item.deliveryId}:{item.receipt}
        </div>
      ))}
    </div>
  ),
}));

afterEach(() => {
  symposiumQueueOperations.reset();
  symposiumExcerptOperations.reset();
  navigation.active = 'session';
  cleanup();
  vi.useRealTimers();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Profiles and advanced guidance' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Profiles and advanced guidance' }));
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
    await screen.findByRole('button', { name: 'Profiles and advanced guidance' });
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/profile-proposals')),
    ).toBe(false);
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
    expect(
      screen.queryByRole('button', { name: 'Draft reusable profile from this seat' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Profiles and advanced guidance' }));
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

  it('fences another audience after an uncertain queue without allocating a new key', async () => {
    const bodies: { idempotencyKey: string; recipientSeatIds: string[] }[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        throw new Error('Response lost');
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
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
    await screen.findByText('Response lost');
    fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message for Reviewer' }), {
      target: { value: 'Another message' },
    });
    expect(
      screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
    expect(bodies).toHaveLength(1);
    expect(symposiumQueueOperations.snapshot().session.request.idempotencyKey).toBe(
      bodies[0].idempotencyKey,
    );
  });

  it('freezes an uncertain excerpt across edits while keeping its session and direct queue keys separate', async () => {
    const bodies: Record<string, unknown>[] = [];
    let directKey = '';
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/share-excerpt') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (bodies.length === 1) throw new Error('Response lost');
        return json({
          ...directedDelivery('awaiting_intervention'),
          ...body,
          sessionId: 'other',
          originalContent: body.excerpt,
          sourceProvenance: null,
        });
      }
      if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        directKey = body.idempotencyKey;
        return json({
          ...directedDelivery('awaiting_intervention'),
          ...body,
          sessionId: 'session',
        });
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
    await openShare();
    fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
    await screen.findByText('Response lost');
    fireEvent.change(screen.getByRole('textbox', { name: 'Excerpt to share' }), {
      target: { value: 'Pl' },
    });
    expect(
      screen.getByRole('button', { name: 'Queue excerpt for approval' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(symposiumExcerptOperations.snapshot().session.request.originalContent).toBe('Plan');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
      target: { value: 'Separate directed message' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
    await waitFor(() => expect(directKey).not.toBe(''));
    expect(directKey).not.toBe(bodies[0].idempotencyKey);
    view.rerender(<SymposiumConversation sessionId="other" chat={chat} ordinaryComposer={null} />);
    await openShare();
    fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].idempotencyKey).not.toBe(bodies[0].idempotencyKey);
    expect(symposiumExcerptOperations.snapshot().session.request.idempotencyKey).toBe(
      bodies[0].idempotencyKey,
    );
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

it('simplifies after the last reviewer is removed but keeps isolated delivery routing', async () => {
  let expanded = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/status'))
      return json({
        sessionId: 'chat',
        config: { version: 2, revision: 8, state: 'active', anchorSeatId: 'architect' },
        deliveries: [
          {
            deliveryId: 'anchor-delivery',
            recipientSeatIds: ['architect'],
            originalContent: 'Continue',
            deliveredContent: 'Continue',
            status: 'ready',
            recipients: [{ seatId: 'architect', status: 'pending' }],
          },
        ],
        runtimeAvailable: true,
        seats: [
          {
            seatId: 'architect',
            seat: { name: 'Architect' },
            admitted: true,
            membership: { state: 'active' },
          },
          {
            seatId: 'reviewer',
            seat: { name: 'Reviewer' },
            admitted: expanded,
            membership: { state: expanded ? 'active' : 'removed' },
          },
        ],
      });
    if (String(url).includes('perspectives')) return json({ items: [], nextSeq: null, queued: [] });
    return json([]);
  });
  render(
    <SymposiumConversation
      sessionId="chat"
      chat={chat}
      ordinaryComposer={<button>Ordinary send</button>}
    />,
  );
  await screen.findByLabelText('Message for Architect');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(await screen.findByRole('button', { name: 'Send to Architect' })).toBeTruthy();
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(
        ([url]) => String(url).includes('kind=seat') && String(url).includes('seatId=architect'),
      ),
  ).toBe(true);
  expect(screen.queryByText('Ordinary send')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Choose agent recipient' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Message for Architect'), {
    target: { value: 'Continue' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  await waitFor(() =>
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/deliveries') &&
            JSON.parse(String(init?.body)).recipientSeatIds.join() === 'architect',
        ),
    ).toBe(true),
  );
  expanded = true;
  window.dispatchEvent(new Event('symposium-roster-changed'));
  const anchorTab = await screen.findByRole('tab', { name: 'Architect' });
  expect(anchorTab.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name: 'Send to Architect' })).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'All' }));
  expect(screen.queryByRole('button', { name: 'Send to Architect' })).toBeNull();
});

const directedDelivery = (deliveryStatus = 'awaiting_intervention') => ({
  deliveryId: 'review-delivery',
  recipientSeatIds: ['architect', 'reviewer'],
  originalContent: 'Original request',
  deliveredContent: 'Reviewed request',
  status: deliveryStatus,
  recipients: [
    { seatId: 'architect', status: 'pending' },
    { seatId: 'reviewer', status: 'pending' },
  ],
});

it.each(['awaiting_intervention', 'ready', 'executing', 'recovery_required'])(
  'keeps All receipts readable without delivery mutations for %s',
  async (deliveryStatus) => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      json(
        String(url).includes('/profile-proposals')
          ? []
          : String(url).includes('/perspectives')
            ? page
            : { ...status, runtimeAvailable: true, deliveries: [directedDelivery(deliveryStatus)] },
      ),
    );
    render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
    await screen.findByRole('article', { name: 'Delivery to Architect, Reviewer' });
    expect(screen.getByText('Original: Original request')).toBeTruthy();
    expect(screen.getByText('Approved content: Reviewed request')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^(Approve delivery|Send to|Stop delivery)/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
    expect(
      await screen.findByRole('button', { name: 'Stop delivery to Architect, Reviewer' }),
    ).toBeTruthy();
    if (deliveryStatus === 'awaiting_intervention')
      expect(
        screen.getByRole('button', { name: 'Approve delivery to Architect, Reviewer' }),
      ).toBeTruthy();
    if (deliveryStatus === 'ready')
      expect(screen.getByRole('button', { name: 'Send to Architect, Reviewer' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(
      screen.queryByRole('button', { name: /^(Approve delivery|Send to|Stop delivery)/ }),
    ).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  },
);

it('approves explicitly, refreshes status, then sends the reviewed delivery once', async () => {
  let delivery = directedDelivery();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/interventions')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: 'approve',
        idempotencyKey: expect.any(String),
      });
      delivery = { ...delivery, status: 'ready' };
      return json(delivery);
    }
    if (String(url).endsWith('/dispatch')) return json(delivery);
    return json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, runtimeAvailable: true, deliveries: [delivery] },
    );
  });
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve delivery to Architect, Reviewer' }),
  );
  const send = await screen.findByRole('button', { name: 'Send to Architect, Reviewer' });
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/dispatch')),
  ).toHaveLength(0);
  expect(screen.getByText('Original: Original request')).toBeTruthy();
  expect(screen.getByText('Approved content: Reviewed request')).toBeTruthy();
  fireEvent.click(send);
  await screen.findByText('Send request completed. See delivery status below.');
  fireEvent.click(send);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/dispatch')),
  ).toHaveLength(1);
});

it('keeps Stop usable while dispatch awaits completion and names every recipient from a seat tab', async () => {
  let finishSend!: (response: Response) => void;
  let finishStop!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/dispatch'))
      return new Promise<Response>((resolve) => {
        finishSend = resolve;
      });
    if (String(url).endsWith('/cancel'))
      return new Promise<Response>((resolve) => {
        finishStop = resolve;
      });
    return json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, runtimeAvailable: true, deliveries: [directedDelivery('ready')] },
    );
  });
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Architect, Reviewer' }));
  fireEvent.click(screen.getByRole('tab', { name: 'All' }));
  expect(screen.queryByRole('button', { name: 'Stop delivery to Architect, Reviewer' })).toBeNull();
  expect(screen.getByText('Original: Original request')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
  const stop = screen.getByRole('button', { name: 'Stop delivery to Architect, Reviewer' });
  expect(stop.hasAttribute('disabled')).toBe(false);
  expect(
    screen.getByText('Stop applies to this entire delivery and all named recipients.'),
  ).toBeTruthy();
  fireEvent.click(stop);
  await screen.findByText('Stopping… awaiting cancellation confirmation.');
  finishStop(json({}));
  await screen.findByText(
    'Cancellation recorded. Provider work may still be finishing; history is preserved.',
  );
  finishSend(json({}));
  await waitFor(() =>
    expect(screen.queryByText('Send request completed. See delivery status below.')).toBeNull(),
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel')),
  ).toHaveLength(1);
});

it.each([true, false])(
  'releases a rejected Send only with explicit no-dispatch proof: %s',
  async (provenNotStarted) => {
    let attempts = 0;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/dispatch')) {
        attempts += 1;
        if (attempts === 1)
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: 'Symposium provider runtime is unavailable',
              ...(provenNotStarted ? { dispatch: 'not-started' } : {}),
            }),
          } as Response;
        return json({});
      }
      return json(
        String(url).includes('/profile-proposals')
          ? []
          : String(url).includes('/perspectives')
            ? page
            : { ...status, runtimeAvailable: true, deliveries: [directedDelivery('ready')] },
      );
    });
    render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
    const send = await screen.findByRole('button', { name: 'Send to Architect, Reviewer' });
    fireEvent.click(send);
    if (provenNotStarted) {
      await screen.findByText(/Send did not start/);
      await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
      expect(attempts).toBe(1);
      fireEvent.click(send);
      await screen.findByText('Send request completed. See delivery status below.');
      expect(attempts).toBe(2);
    } else {
      await screen.findByText(/Send outcome is uncertain/);
      expect(send.hasAttribute('disabled')).toBe(true);
      fireEvent.click(send);
      expect(attempts).toBe(1);
    }
  },
);

it.each(['send', 'stop'] as const)(
  'settles a rejected %s by delivery identity while the operator is in another session',
  async (action) => {
    let finish!: (response: Response) => void;
    let attempts = 0;
    const suffix = action === 'send' ? '/dispatch' : '/cancel';
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith(suffix)) {
        attempts++;
        if (attempts === 1)
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return json({});
      }
      return json(
        path.includes('/profile-proposals')
          ? []
          : path.includes('/perspectives')
            ? page
            : {
                ...status,
                sessionId: path.includes('/other/') ? 'other' : 'session',
                runtimeAvailable: true,
                deliveries: [directedDelivery('ready')],
              },
      );
    });
    const view = render(
      <SymposiumConversation
        key="session"
        sessionId="session"
        chat={chat}
        ordinaryComposer={null}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
    const label =
      action === 'send' ? 'Send to Architect, Reviewer' : 'Stop delivery to Architect, Reviewer';
    fireEvent.click(await screen.findByRole('button', { name: label }));
    view.rerender(
      <SymposiumConversation key="other" sessionId="other" chat={chat} ordinaryComposer={null} />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
    expect((await screen.findByRole('button', { name: label })).hasAttribute('disabled')).toBe(
      false,
    );
    await act(async () => {
      finish({
        ok: false,
        status: action === 'send' ? 503 : 409,
        json: async () => ({
          error: 'Request rejected',
          ...(action === 'send' ? { dispatch: 'not-started' } : {}),
        }),
      } as Response);
    });
    view.rerender(
      <SymposiumConversation
        key="session"
        sessionId="session"
        chat={chat}
        ordinaryComposer={null}
      />,
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
    const retry = await screen.findByRole('button', { name: label });
    expect(retry.hasAttribute('disabled')).toBe(false);
    expect(attempts).toBe(1);
    fireEvent.click(retry);
    await waitFor(() => expect(attempts).toBe(2));
    if (action === 'stop') {
      const bodies = vi
        .mocked(apiFetch)
        .mock.calls.filter(([url]) => String(url).endsWith(suffix))
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
    }
  },
);

it('retains pending and uncertain Send fences across keyed session remounts', async () => {
  let rejectSend!: (error: Error) => void;
  let sends = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/dispatch')) {
      sends++;
      return new Promise<Response>((_resolve, reject) => {
        rejectSend = reject;
      });
    }
    return json(
      path.includes('/profile-proposals')
        ? []
        : path.includes('/perspectives')
          ? page
          : {
              ...status,
              sessionId: path.includes('/other/') ? 'other' : 'session',
              runtimeAvailable: true,
              deliveries: [directedDelivery('ready')],
            },
    );
  });
  navigation.active = 'session';
  const view = render(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Architect, Reviewer' }));
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  expect(
    (await screen.findByRole('button', { name: 'Send to Architect, Reviewer' })).hasAttribute(
      'disabled',
    ),
  ).toBe(false);
  navigation.active = 'session';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  expect(
    (await screen.findByRole('button', { name: 'Send to Architect, Reviewer' })).hasAttribute(
      'disabled',
    ),
  ).toBe(true);
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  await act(async () => {
    rejectSend(new Error('Response lost'));
  });
  navigation.active = 'session';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  await screen.findByText(/Send outcome is uncertain/);
  const send = screen.getByRole('button', { name: 'Send to Architect, Reviewer' });
  expect(send.hasAttribute('disabled')).toBe(true);
  fireEvent.click(send);
  expect(sends).toBe(1);
});

it('blocks uncertain dispatch repeats and retries only explicit idempotent Stop', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/dispatch') || String(url).endsWith('/cancel'))
      throw new Error('Response lost');
    return json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, runtimeAvailable: true, deliveries: [directedDelivery('ready')] },
    );
  });
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Architect, Reviewer' }));
  await screen.findByText(/Send outcome is uncertain/);
  fireEvent.click(screen.getByRole('button', { name: 'Send to Architect, Reviewer' }));
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/dispatch')),
  ).toHaveLength(1);
  const stop = screen.getByRole('button', { name: 'Stop delivery to Architect, Reviewer' });
  fireEvent.click(stop);
  await screen.findByText(/Stop is unconfirmed/);
  await waitFor(() => expect(stop.hasAttribute('disabled')).toBe(false));
  fireEvent.click(stop);
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel')),
    ).toHaveLength(2),
  );
  const bodies = vi
    .mocked(apiFetch)
    .mock.calls.filter(([url]) => String(url).endsWith('/cancel'))
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey);
});

it('hides unrelated delivery content from a seat and pauses Send without a runtime', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : {
              ...status,
              runtimeAvailable: false,
              deliveries: [
                directedDelivery('ready'),
                {
                  ...directedDelivery(),
                  deliveryId: 'private',
                  recipientSeatIds: ['architect'],
                  originalContent: 'Architect private input',
                },
              ],
            },
    ),
  );
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  const section = await screen.findByRole('region', { name: 'Conversation deliveries' });
  expect(screen.getByTestId('rich-chat').contains(section)).toBe(true);
  expect(within(section).queryByText('Original: Architect private input')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Send to Architect, Reviewer' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText('Provider runtime is unavailable. Sending is paused.')).toBeTruthy();
});

it('uses durable recipient execution evidence to block Send after reload', async () => {
  const delivery = {
    ...directedDelivery('ready'),
    recipients: [{ seatId: 'reviewer', status: 'recovery_required' }],
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, runtimeAvailable: true, deliveries: [delivery] },
    ),
  );
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  const send = await screen.findByRole('button', { name: 'Send to Architect, Reviewer' });
  expect(send.hasAttribute('disabled')).toBe(true);
  fireEvent.click(send);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/dispatch')),
  ).toHaveLength(0);
  expect(screen.getByText(/Recipient execution has already started/)).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'Stop delivery to Architect, Reviewer' })
      .hasAttribute('disabled'),
  ).toBe(false);
});

it('collapses terminal receipts and distinguishes recorded cancellation from provider cleanup', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, deliveries: [directedDelivery('cancelled')] },
    ),
  );
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  const receipt = (
    await screen.findByRole('article', { name: 'Delivery to Architect, Reviewer' })
  ).querySelector('summary')!;
  expect(receipt.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    'To Architect, Reviewer · cancelled',
  );
  expect(receipt.closest('details')?.hasAttribute('open')).toBe(false);
  expect(screen.getByText(/Provider cleanup is not confirmed by this receipt/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send to Architect, Reviewer' })).toBeNull();
});

it('retains Stop during an in-flight dispatch when a status refresh fails', async () => {
  let statusUnavailable = false;
  let finishSend!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/dispatch'))
      return new Promise<Response>((resolve) => {
        finishSend = resolve;
      });
    if (String(url).endsWith('/cancel')) return json({});
    if (String(url).endsWith('/status') && statusUnavailable)
      throw new Error('Status temporarily unavailable');
    return json(
      String(url).includes('/profile-proposals')
        ? []
        : String(url).includes('/perspectives')
          ? page
          : { ...status, runtimeAvailable: true, deliveries: [directedDelivery('ready')] },
    );
  });
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send to Architect, Reviewer' }));
  statusUnavailable = true;
  window.dispatchEvent(new Event('symposium-deliveries-changed'));
  await screen.findByText('Status temporarily unavailable');
  expect(screen.getByText(/New approvals and sending are paused/)).toBeTruthy();
  const stop = screen.getByRole('button', { name: 'Stop delivery to Architect, Reviewer' });
  expect(stop.hasAttribute('disabled')).toBe(false);
  fireEvent.click(stop);
  await screen.findByText(
    'Cancellation recorded. Provider work may still be finishing; history is preserved.',
  );
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel')),
  ).toHaveLength(1);
  finishSend(json({}));
});

it('keeps All as a read-only timeline and directs the composer only to a selected agent ID', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    json(String(url).includes('/perspectives') ? page : status),
  );
  render(
    <SymposiumConversation
      sessionId="session"
      chat={chat}
      ordinaryComposer={<div>Ordinary composer</div>}
    />,
  );
  await screen.findByRole('tab', { name: 'All' });
  expect(screen.queryByRole('textbox', { name: /Message for/ })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
  expect(await screen.findByRole('textbox', { name: 'Message for Reviewer' })).toBeTruthy();
});

it('offers @ recipients only for admitted agents, excluding removed history from targeting', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    json(
      String(url).includes('/perspectives')
        ? page
        : {
            ...status,
            seats: [
              ...status.seats,
              {
                seatId: 'removed',
                seat: { name: 'Former reviewer', role: 'reviewer' },
                admitted: false,
                membership: { state: 'removed' },
              },
            ],
          },
    ),
  );
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={<div />} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose agent recipient' }));
  const picker = screen.getByRole('region', { name: 'Agent recipients' });
  expect(within(picker).queryByRole('button', { name: /Former reviewer/ })).toBeNull();
  expect(within(picker).getByRole('button', { name: 'Reviewer' })).toBeTruthy();
});

it('coalesces polling ticks and explicit events into one status read and one follow-up', async () => {
  vi.useFakeTimers();
  const finish: ((response: Response) => void)[] = [];
  let statusReads = 0;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/status')) {
      statusReads++;
      if (statusReads <= 2) return new Promise<Response>((resolve) => finish.push(resolve));
      return json(status);
    }
    return json(String(url).includes('/perspectives') ? page : []);
  });
  const view = render(
    <SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(24000);
  });
  window.dispatchEvent(new Event('symposium-deliveries-changed'));
  window.dispatchEvent(new Event('symposium-roster-changed'));
  expect(statusReads).toBe(1);
  await act(async () => {
    finish[0](json(status));
  });
  expect(statusReads).toBe(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16000);
  });
  expect(statusReads).toBe(2);
  await act(async () => {
    finish[1](json(status));
  });
  expect(statusReads).toBe(3);
  view.unmount();
});

it.each(['transport', 'body'] as const)(
  'recovers a stalled status %s even when abort is ignored and discards its late result',
  async (stallAt) => {
    vi.useFakeTimers();
    let finishStalled!: (value: unknown) => void;
    let finishFresh!: (response: Response) => void;
    const signals: (AbortSignal | null | undefined)[] = [];
    let statusReads = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/status')) {
        statusReads++;
        signals.push(init?.signal);
        if (statusReads === 1) {
          // Deliberately ignore AbortSignal to exercise the queue's own deadline.
          const stalled = new Promise<unknown>((resolve) => {
            finishStalled = resolve;
          });
          return stallAt === 'transport'
            ? (stalled as Promise<Response>)
            : ({ ok: true, json: () => stalled } as Response);
        }
        return new Promise<Response>((resolve) => {
          finishFresh = resolve;
        });
      }
      return json(String(url).includes('/perspectives') ? page : []);
    });
    const view = render(
      <SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />,
    );
    await act(async () => {
      window.dispatchEvent(new Event('symposium-deliveries-changed'));
      window.dispatchEvent(new Event('symposium-roster-changed'));
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(statusReads).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(statusReads).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(screen.getByText('Symposium status request timed out.')).toBeTruthy();
    await act(async () => {
      finishFresh(
        json({ ...status, runtimeAvailable: true, deliveries: [directedDelivery('ready')] }),
      );
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Reviewer' }));
    expect(
      screen.getByRole('button', { name: 'Stop delivery to Architect, Reviewer' }),
    ).toBeTruthy();
    expect(screen.queryByText('Symposium status request timed out.')).toBeNull();
    await act(async () => {
      finishStalled(stallAt === 'transport' ? json(status) : status);
    });
    expect(
      screen.getByRole('button', { name: 'Stop delivery to Architect, Reviewer' }),
    ).toBeTruthy();
    expect(statusReads).toBe(2);
    view.unmount();
  },
);

it('loads new-session Stop controls even when the retired status request never completes', async () => {
  const reads: string[] = [];
  const finish: ((response: Response) => void)[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/status')) {
      reads.push(String(url));
      return new Promise<Response>((resolve) => finish.push(resolve));
    }
    return json(String(url).includes('/perspectives') ? page : []);
  });
  const view = render(
    <SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />,
  );
  window.dispatchEvent(new Event('symposium-deliveries-changed'));
  view.rerender(<SymposiumConversation sessionId="other" chat={chat} ordinaryComposer={null} />);
  expect(reads).toEqual([
    '/api/sessions/session/symposium/status',
    '/api/sessions/other/symposium/status',
  ]);
  await act(async () => {
    finish[1](
      json({
        ...status,
        sessionId: 'other',
        runtimeAvailable: true,
        seats: status.seats.map((seat) => ({ ...seat, seat: { name: `Other ${seat.seat.name}` } })),
        deliveries: [directedDelivery('ready')],
      }),
    );
  });
  fireEvent.click(screen.getByRole('tab', { name: 'Other Reviewer' }));
  expect(
    await screen.findByRole('button', { name: 'Stop delivery to Other Architect, Other Reviewer' }),
  ).toBeTruthy();
  await act(async () => {
    finish[0](json(status));
  });
  expect(
    screen.getByRole('button', { name: 'Stop delivery to Other Architect, Other Reviewer' }),
  ).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Reviewer' })).toBeNull();
  expect(reads).toHaveLength(2);
});

it('can request a send from durable status and keeps runtime refusal explicit without retrying', async () => {
  const durable = {
    ...status,
    runtimeVerification: 'not_checked',
    runtimeAvailable: false,
    seats: status.seats.map((seat) => ({
      ...seat,
      admitted: false,
      admissionRecorded: true,
      savedRuntimeState: 'ready',
      membership: { state: 'active', reconciliation: 'confirmed' },
    })),
    deliveries: [
      {
        deliveryId: 'saved-delivery',
        recipientSeatIds: ['reviewer'],
        status: 'ready',
        originalContent: 'Review this',
        deliveredContent: 'Review this',
        recipients: [{ seatId: 'reviewer', status: 'pending' }],
      },
    ],
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/dispatch')
      ? ({ ok: false, json: async () => ({ error: 'Agent service unavailable' }) } as Response)
      : json(String(url).includes('/perspectives') ? page : durable),
  );
  render(<SymposiumConversation sessionId="session" chat={chat} ordinaryComposer={null} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Reviewer' }));
  const send = await screen.findByRole('button', { name: 'Send to Reviewer' });
  expect(send.hasAttribute('disabled')).toBe(false);
  fireEvent.click(send);
  expect(await screen.findByText(/Agent service unavailable/)).toBeTruthy();
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/dispatch')),
  ).toHaveLength(1);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([url]) => String(url) === '/api/sessions/session/symposium'),
  ).toBe(false);
});
it('retains the pending directed queue identity through the actual keyed session remount', async () => {
  let finish!: (response: Response) => void;
  const requests: Record<string, unknown>[] = [];
  navigation.active = 'session';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return json(
      String(url).endsWith('/status')
        ? { ...status, sessionId: String(url).split('/')[3] }
        : String(url).includes('/perspectives')
          ? page
          : [],
    );
  });
  const view = render(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
    target: { value: 'Original draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  await screen.findByRole('tab', { name: 'Architect' });
  navigation.active = 'session';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
    target: { value: 'Original draft' },
  });
  expect(screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  expect(requests).toHaveLength(1);
  await act(async () =>
    finish(
      json({
        ...directedDelivery('awaiting_intervention'),
        ...requests[0],
        sessionId: 'session',
        deliveryId: 'saved-queue',
      }),
    ),
  );
});
it('keeps a lost directed queue fenced on return until its exact saved delivery is proven', async () => {
  const requests: Record<string, unknown>[] = [];
  let saved: Record<string, unknown>[] = [];
  navigation.active = 'session';
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)));
      throw new Error('Queue response lost');
    }
    return json(
      String(url).endsWith('/status')
        ? { ...status, sessionId: String(url).split('/')[3], deliveries: saved }
        : String(url).includes('/perspectives')
          ? page
          : [],
    );
  });
  const view = render(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
    target: { value: 'Original draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
  await screen.findByText('Queue response lost');
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  await screen.findByRole('tab', { name: 'Architect' });
  navigation.active = 'session';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
    target: { value: 'A different draft' },
  });
  expect(screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled')).toBe(
    true,
  );
  for (const mismatch of [
    { idempotencyKey: 'unrelated-key' },
    { sessionId: 'other' },
    { sourceSeatId: 'reviewer' },
    { sourceMessageId: 'linked-message' },
    { recipientSeatIds: ['reviewer'] },
    { originalContent: 'Different content' },
    { deliveryId: undefined },
    { status: 'invalid' },
  ]) {
    saved = [
      {
        ...directedDelivery('awaiting_intervention'),
        ...requests[0],
        sessionId: 'session',
        ...mismatch,
      },
    ];
    fireEvent.click(screen.getByRole('button', { name: 'Check whether this message was queued' }));
    await act(async () => {});
    expect(screen.queryByText('Message already queued')).toBeNull();
    expect(requests).toHaveLength(1);
  }
  saved = [
    {
      ...directedDelivery('awaiting_intervention'),
      ...requests[0],
      sessionId: 'session',
      deliveryId: 'saved-queue',
    },
  ];
  fireEvent.click(screen.getByRole('button', { name: 'Check whether this message was queued' }));
  await screen.findByText('Message already queued');
  expect(requests).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Write another message' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(screen.getByRole('textbox', { name: 'Message for Architect' })).toHaveProperty(
    'value',
    'A different draft',
  );
});
it.each(['transport', 'body'] as const)(
  'bounds a stalled directed queue %s and ignores its late result after keyed navigation',
  async (stallAt) => {
    let finish!: (value: unknown) => void;
    let request: Record<string, unknown> = {};
    let signal: AbortSignal | null | undefined;
    navigation.active = 'session';
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/deliveries') && init?.method === 'POST') {
        request = JSON.parse(String(init.body));
        signal = init.signal;
        const stalled = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        return stallAt === 'transport'
          ? (stalled as Promise<Response>)
          : ({ ok: true, json: () => stalled } as Response);
      }
      return json(
        String(url).endsWith('/status')
          ? { ...status, sessionId: String(url).split('/')[3] }
          : String(url).includes('/perspectives')
            ? page
            : [],
      );
    });
    const view = render(<ResponsiveChatView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
      target: { value: 'Original draft' },
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Queue for approval' }));
    await act(async () => {});
    expect(symposiumQueueOperations.snapshot().session.phase).toBe('pending');
    navigation.active = 'other';
    view.rerender(<ResponsiveChatView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(signal?.aborted).toBe(true);
    expect(symposiumQueueOperations.snapshot().session.phase).toBe('uncertain');
    expect(symposiumQueueOperations.snapshot().session.request.idempotencyKey).toBe(
      request.idempotencyKey,
    );
    expect(symposiumQueueOperations.snapshot().other).toBeUndefined();
    const receipt = {
      ...directedDelivery('awaiting_intervention'),
      ...request,
      sessionId: 'session',
      deliveryId: 'late-result',
    };
    await act(async () => finish(stallAt === 'transport' ? json(receipt) : receipt));
    expect(symposiumQueueOperations.snapshot().session.phase).toBe('uncertain');
    vi.useRealTimers();
    navigation.active = 'session';
    view.rerender(<ResponsiveChatView />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message for Architect' }), {
      target: { value: 'Original draft' },
    });
    expect(
      screen.getByRole('button', { name: 'Queue for approval' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Check whether this message was queued' })
        .hasAttribute('disabled'),
    ).toBe(false);
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.filter(
          ([url, init]) => String(url).endsWith('/deliveries') && init?.method === 'POST',
        ),
    ).toHaveLength(1);
  },
);
it('fences a lost excerpt through keyed session navigation and resolves only its original source provenance', async () => {
  navigation.active = 'session';
  let captured: Record<string, unknown> = {};
  let saved: Record<string, unknown>[] = [];
  const provenance = {
    seatId: 'architect',
    membershipGeneration: 7,
    accountId: 'approved-account',
  };
  const versionedPage = {
    ...page,
    items: page.items.map((item) =>
      item.kind === 'authored' && item.seatId === 'architect' ? { ...item, provenance } : item,
    ),
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/share-excerpt') && init?.method === 'POST') {
      captured = JSON.parse(String(init.body));
      throw new Error('Excerpt response lost');
    }
    return json(
      String(url).endsWith('/status')
        ? { ...status, sessionId: String(url).split('/')[3], deliveries: saved }
        : String(url).includes('/perspectives')
          ? versionedPage
          : [],
    );
  });
  const view = render(<ResponsiveChatView />);
  const open = async () => {
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share excerpt' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  };
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
  await screen.findByText('Excerpt response lost');
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  await screen.findByRole('tab', { name: 'Architect' });
  navigation.active = 'session';
  view.rerender(<ResponsiveChatView />);
  await open();
  expect(
    screen.getByRole('button', { name: 'Queue excerpt for approval' }).hasAttribute('disabled'),
  ).toBe(true);
  const receipt = {
    ...directedDelivery('awaiting_intervention'),
    ...captured,
    sessionId: 'session',
    originalContent: captured.excerpt,
    sourceProvenance: provenance,
  };
  saved = [{ ...receipt, sourceProvenance: { ...provenance, membershipGeneration: 8 } }];
  fireEvent.click(screen.getByRole('button', { name: 'Check whether this excerpt was queued' }));
  await act(async () => {});
  expect(screen.queryByText('Excerpt already queued')).toBeNull();
  saved = [receipt];
  fireEvent.click(screen.getByRole('button', { name: 'Check whether this excerpt was queued' }));
  await screen.findByText('Excerpt already queued');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([url, init]) => String(url).endsWith('/share-excerpt') && init?.method === 'POST',
      ),
  ).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Queue excerpt for approval' }).hasAttribute('disabled'),
  ).toBe(true);
});
it.each(['transport', 'body'] as const)(
  'bounds a stalled excerpt %s and retains its original key after keyed remount',
  async (stallAt) => {
    navigation.active = 'session';
    let finish!: (value: unknown) => void;
    let captured: Record<string, unknown> = {};
    let signal: AbortSignal | null | undefined;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/share-excerpt') && init?.method === 'POST') {
        captured = JSON.parse(String(init.body));
        signal = init.signal;
        const stalled = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        return stallAt === 'transport'
          ? (stalled as Promise<Response>)
          : ({ ok: true, json: () => stalled } as Response);
      }
      return json(
        String(url).endsWith('/status')
          ? { ...status, sessionId: String(url).split('/')[3] }
          : String(url).includes('/perspectives')
            ? page
            : [],
      );
    });
    const view = render(<ResponsiveChatView />);
    const open = async () => {
      fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Share excerpt' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
    };
    await open();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
    await act(async () => {});
    navigation.active = 'other';
    view.rerender(<ResponsiveChatView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(signal?.aborted).toBe(true);
    expect(symposiumExcerptOperations.snapshot().session.phase).toBe('uncertain');
    expect(symposiumExcerptOperations.snapshot().session.request.idempotencyKey).toBe(
      captured.idempotencyKey,
    );
    expect(symposiumExcerptOperations.snapshot().other).toBeUndefined();
    const receipt = {
      ...directedDelivery('awaiting_intervention'),
      ...captured,
      originalContent: captured.excerpt,
      sourceProvenance: null,
      sessionId: 'session',
    };
    await act(async () => finish(stallAt === 'transport' ? json(receipt) : receipt));
    expect(symposiumExcerptOperations.snapshot().session.phase).toBe('uncertain');
    vi.useRealTimers();
    navigation.active = 'session';
    view.rerender(<ResponsiveChatView />);
    await open();
    expect(
      screen.getByRole('button', { name: 'Queue excerpt for approval' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.filter(
          ([url, init]) => String(url).endsWith('/share-excerpt') && init?.method === 'POST',
        ),
    ).toHaveLength(1);
  },
);
it('settles a pending excerpt for its original session without closing the new session share form', async () => {
  navigation.active = 'session';
  let finish!: (response: Response) => void;
  let captured: Record<string, unknown> = {};
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/share-excerpt') && init?.method === 'POST') {
      captured = JSON.parse(String(init.body));
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return json(
      String(url).endsWith('/status')
        ? { ...status, sessionId: String(url).split('/')[3] }
        : String(url).includes('/perspectives')
          ? page
          : [],
    );
  });
  const view = render(<ResponsiveChatView />);
  const open = async () => {
    fireEvent.click(await screen.findByRole('tab', { name: 'Architect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Share excerpt' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  };
  await open();
  fireEvent.click(screen.getByRole('button', { name: 'Queue excerpt for approval' }));
  await waitFor(() => expect(finish).toBeDefined());
  navigation.active = 'other';
  view.rerender(<ResponsiveChatView />);
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: 'Excerpt to share' }), {
    target: { value: 'Pl' },
  });
  const events = vi.spyOn(window, 'dispatchEvent');
  await act(async () =>
    finish(
      json({
        ...directedDelivery('awaiting_intervention'),
        ...captured,
        sessionId: 'session',
        originalContent: captured.excerpt,
        sourceProvenance: null,
      }),
    ),
  );
  expect(symposiumExcerptOperations.snapshot().session.phase).toBe('confirmed');
  expect(symposiumExcerptOperations.snapshot().other).toBeUndefined();
  expect(screen.getByRole('textbox', { name: 'Excerpt to share' })).toHaveProperty('value', 'Pl');
  expect(events.mock.calls.some(([event]) => event.type === 'symposium-deliveries-changed')).toBe(
    false,
  );
  events.mockRestore();
});
