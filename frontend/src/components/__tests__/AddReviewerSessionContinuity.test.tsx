// @vitest-environment jsdom
import type {
  SymposiumConfig,
  SymposiumConfigurationOperationReceipt,
  SeatConfig,
} from '@mitzo/protocol';
import { reviewerOperations } from '../../lib/symposium-reviewer-operations';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponsiveChatView } from '../ResponsiveChatView';
import { apiFetch } from '../../lib/api-fetch';
type Config = Extract<SymposiumConfig, { version: 2 }>;
type Receipt = Omit<SymposiumConfigurationOperationReceipt, 'config'> & { config: Config };
const session = vi.hoisted(() => ({ id: 'first' }));
vi.mock('@mitzo/client/hooks', () => ({ useMitzoStore: () => session.id }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('../../pages/DesktopChatView', async () => {
  const { AddAgentSheet } = await import('../AddReviewerSheet');
  return { DesktopChatView: () => <AddAgentSheet sessionId={session.id} /> };
});
vi.mock('../../pages/ChatView', () => ({ ChatView: () => null }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange(v: unknown): void }) => (
    <button onClick={() => onChange({ accountId: 'a', model: 'luna', reasoningEffort: 'low' })}>
      Choose account
    </button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({ SymposiumProfilePicker: () => null }));
const config = {
  version: 2,
  revision: 1,
  state: 'active',
  anchorSeatId: 'anchor',
  seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
};
const response = (v: unknown) => new Response(JSON.stringify(v));
const status = () => ({
  sessionId: session.id,
  config,
  runtimeAvailable: true,
  seats: [{ seatId: 'anchor', membership: { state: 'active', generation: 1 } }],
  deliveries: [],
});
afterEach(() => {
  vi.useRealTimers();
  reviewerOperations.reset();
  cleanup();
  vi.resetAllMocks();
  session.id = 'first';
});
async function start() {
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Agent name'), {
    target: { value: 'Reviewer continuity' },
  });
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Check only approved changes' },
  });
  fireEvent.change(screen.getByLabelText('Initial message'), {
    target: { value: 'Approved initial message' },
  });
  fireEvent.click(screen.getByText('Choose account'));
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
}
it('stops the old pipeline at the actual ResponsiveChatView session remount after context preparation', async () => {
  let resolve!: (v: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/context-package')
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : response(status()),
  );
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(resolve).toBeDefined());
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => resolve(response({ content: 'Approved context' })));
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/seats/revise')),
  ).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/membership'))).toBe(
    false,
  );
});
it('keeps uncertain seat mutation identity and immutable approval across actual keyed session remounts', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/context-package')
      ? response({ content: '' })
      : String(url).endsWith('/seats/revise')
        ? new Promise<Response>((_, fail) => {
            reject = fail;
          })
        : response(status()),
  );
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(reject).toBeDefined());
  const original = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => reject(new Error('Response lost')));
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByLabelText('Agent name')).toHaveValue('Reviewer continuity');
  expect(screen.getByLabelText('Initial message')).toHaveValue('Approved initial message');
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
  ).toHaveLength(1);
  expect(JSON.parse(String(original[1]?.body)).seatId).toMatch(/^agent-/);
});
it('resolves a lost first message only from its exact saved receipt after keyed remount', async () => {
  const localConfig = structuredClone(config);
  let reject!: (error: Error) => void;
  let queued: Record<string, unknown> | undefined;
  let receipt: Record<string, unknown> | undefined;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/context-package')) return response({ content: 'Frozen full context' });
    if (path.endsWith('/status'))
      return response({
        sessionId: 'first',
        config: localConfig,
        runtimeAvailable: true,
        seats: localConfig.seats.map((seat) => ({
          seatId: seat.id,
          membership: { state: 'active', generation: 1 },
        })),
        deliveries: receipt ? [receipt] : [],
      });
    if (path.endsWith('/seats/revise')) {
      const body = JSON.parse(String(init?.body));
      localConfig.revision++;
      localConfig.seats.push({
        ...body,
        id: body.seatId,
        accountBinding: { accountId: body.accountId, model: body.model, bindingRevision: 7 },
      });
      return response(localConfig);
    }
    if (path.endsWith('/deliveries')) {
      queued = JSON.parse(String(init?.body));
      return new Promise<Response>((_, fail) => {
        reject = fail;
      });
    }
    return response({});
  });
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(reject).toBeDefined());
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => reject(new Error('Queue response lost')));
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  receipt = { ...queued, sessionId: 'first', idempotencyKey: 'different-operation' };
  fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  receipt = { ...queued, sessionId: 'first' };
  fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
  await screen.findByText(/Agent added/);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/deliveries')),
  ).toHaveLength(1);
  expect(queued?.originalContent).toContain('Frozen full context');
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/context-package')),
  ).toHaveLength(1);
});
it('releases the pending wait after a bounded timeout while preserving uncertain identity across remount', async () => {
  let started = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/context-package')) return response({ content: '' });
    if (String(url).endsWith('/seats/revise')) {
      started = true;
      vi.useFakeTimers();
      return new Promise<Response>(() => {});
    }
    return response(status());
  });
  const view = render(<ResponsiveChatView />);
  await act(async () => {
    await start();
  });
  expect(started).toBe(true);
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  const operation = Object.values(reviewerOperations.snapshot())[0];
  expect(operation.pending).toBe(true);
  expect(operation.uncertain?.path).toMatch(/seats\/revise$/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  vi.useRealTimers();
  expect(Object.values(reviewerOperations.snapshot())[0].pending).toBe(false);
  expect(Object.values(reviewerOperations.snapshot())[0].uncertain).toEqual(operation.uncertain);
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check saved operation' })).toBeEnabled();
  expect(Object.values(reviewerOperations.snapshot())[0].key).toBe(operation.key);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
  ).toHaveLength(1);
});

it('releases only a proven pre-mutation draft refusal so ordinary execution can be stopped and approved again', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/context-package')) return response({ content: '' });
    if (path.endsWith('/draft'))
      return new Response(
        JSON.stringify({
          error: 'Stop the ordinary conversation before creating a Symposium draft',
          seatMutation: 'not-started',
        }),
        { status: 409 },
      );
    return response({
      sessionId: session.id,
      config: null,
      ordinaryAccountId: 'a',
      runtimeAvailable: true,
      seats: [],
      deliveries: [],
    });
  });
  render(<ResponsiveChatView />);
  await start();
  await screen.findByText(/Stop the ordinary conversation before creating/);
  await waitFor(() => expect(screen.getByLabelText('Agent name')).toBeEnabled());
  expect(reviewerOperations.snapshot()).toEqual({});
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/draft')),
  ).toHaveLength(1);
});

it.each(['draft', 'config', 'seats/revise', 'activate'] as const)(
  'recovers only the exact lost %s receipt across keyed remount and continues only explicitly',
  async (lostStage) => {
    const binding = {
      accountId: 'a',
      accountLabel: 'A',
      provider: 'openai-codex' as const,
      model: 'luna',
      profileRevision: 'binding-1',
    };
    let current: Config | null =
      lostStage === 'draft'
        ? null
        : {
            version: 2,
            revision: 1,
            state: lostStage === 'seats/revise' ? 'active' : 'draft',
            anchorSeatId: 'anchor',
            activeSeatCap: 3,
            seats: [
              {
                id: 'anchor',
                name: 'Anchor',
                role: 'agent',
                systemPrompt: '',
                color: '#335577',
                model: 'luna',
                accountBinding: binding,
              },
            ],
            turnRules: { mode: 'directed', maxTurns: 8 },
            interceptMode: 'manual',
          };
    const activeConfig = () => {
      if (current?.state === 'active')
        current.seats = current.seats.map((seat) => ({
          ...seat,
          profileBinding: seat.profileBinding ?? { profileId: 'synthetic', profileRevision: '1' },
          contextGrant: seat.contextGrant ?? {
            grantId: 'context-' + seat.id,
            revision: 1,
            classification: 'personal',
            sourceRefs: [],
          },
          authorityGrant: seat.authorityGrant ?? {
            grantId: 'authority-' + seat.id,
            revision: 1,
            filesystem: 'read',
            tools: 'read',
            network: 'restricted',
          },
          isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
        }));
    };
    activeConfig();
    let original: Receipt | undefined;
    let visible: unknown = null;
    let stalledReceiptBody: Promise<unknown> | undefined;
    let lose = true;
    const writes: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.includes('/configuration-operations/')) {
        const proof = response({ receipt: visible });
        if (stalledReceiptBody) proof.json = () => stalledReceiptBody!;
        return proof;
      }
      if (path.endsWith('/status'))
        return response({
          sessionId: session.id,
          config: current,
          symposiumRevision: current?.revision ?? 0,
          ordinaryAccountId: 'a',
          runtimeAvailable: true,
          seats:
            current?.seats.map((seat) => ({
              seatId: seat.id,
              membership: { state: 'active', generation: 1 },
            })) ?? [],
          deliveries: [],
        });
      if (path.endsWith('/context-package'))
        return response({ content: 'Frozen approved context' });
      if (path.endsWith('/selection')) return response({ binding });
      const body = JSON.parse(String(init?.body ?? '{}'));
      const action = path.endsWith('/seats/revise') ? 'seats/revise' : path.split('/').at(-1)!;
      if (['draft', 'config', 'seats/revise', 'activate'].includes(action)) {
        writes.push(action);
        if (action === 'draft')
          current = {
            version: 2,
            revision: 1,
            state: 'draft',
            anchorSeatId: 'anchor',
            activeSeatCap: 3,
            seats: [
              {
                id: 'anchor',
                name: 'Anchor',
                role: 'agent',
                systemPrompt: '',
                color: '#335577',
                model: 'luna',
                accountBinding: binding,
              },
            ],
            turnRules: { mode: 'directed', maxTurns: 8 },
            interceptMode: 'manual',
          };
        if (action === 'config') current = structuredClone(body.config);
        if (action === 'seats/revise') {
          const { expectedRevision, seatId } = body;
          const guidance = Object.fromEntries(
            Object.entries(body).filter(
              ([key]) =>
                ![
                  'expectedRevision',
                  'seatId',
                  'accountId',
                  'contextSourceRefs',
                  'sharedBoundaryAcknowledged',
                  'idempotencyKey',
                ].includes(key),
            ),
          ) as SeatConfig;
          current = {
            ...current!,
            revision: expectedRevision + 1,
            seats: [...current!.seats, { ...guidance, id: seatId, accountBinding: binding }],
          };
        }
        if (action === 'activate')
          current = { ...current!, state: 'active', revision: body.expectedRevision + 1 };
        activeConfig();
        if (action === lostStage && lose) {
          lose = false;
          original = {
            version: 1,
            actor: 'internal-operator',
            sessionId: 'first',
            idempotencyKey: body.idempotencyKey,
            action,
            expectedRevision: body.expectedRevision,
            request: body,
            config: structuredClone(current!),
            completedAt: 1,
          };
          throw new Error('Original response lost');
        }
        return response(current);
      }
      if (action === 'deliveries')
        return response({ ...body, sessionId: session.id, deliveryId: 'queued-original' });
      return response({});
    });
    const view = render(<ResponsiveChatView />);
    await start();
    await screen.findByText('Original response lost');
    session.id = 'second';
    view.rerender(<ResponsiveChatView />);
    session.id = 'first';
    view.rerender(<ResponsiveChatView />);
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const button = () => screen.getByRole('button', { name: 'Add agent and queue message' });
    expect(encodeURIComponent(original!.idempotencyKey)).toBe(original!.idempotencyKey);
    expect(button()).toBeDisabled();
    const before = writes.length;
    for (const wrong of [
      { idempotencyKey: 'other' },
      { request: { ...original!.request, expectedRevision: 99 } },
      ...(lostStage === 'draft'
        ? []
        : [
            {
              config: {
                ...original!.config,
                seats: original!.config.seats.map((seat) =>
                  seat.id.startsWith('agent-') ? { ...seat, model: 'different' } : seat,
                ),
              },
            },
          ]),
    ]) {
      visible = { ...original!, ...wrong };
      const beforeWrong = current;
      if ('config' in wrong && wrong.config) current = wrong.config;
      fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
      await act(async () => {});
      expect(button()).toBeDisabled();
      current = beforeWrong;
    }
    if (lostStage === 'seats/revise') {
      vi.useFakeTimers();
      let release!: (value: unknown) => void;
      stalledReceiptBody = new Promise((resolve) => {
        release = resolve;
      });
      fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(button()).toBeDisabled();
      release({ receipt: original! });
      await act(async () => {});
      expect(button()).toBeDisabled();
      stalledReceiptBody = undefined;
      vi.useRealTimers();
    }
    visible = original!;
    fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
    await waitFor(() => expect(button()).toBeEnabled());
    expect(writes).toHaveLength(before);
    const approvedConfig = structuredClone(current);
    current = { ...current!, interceptMode: 'auto' };
    fireEvent.click(button());
    await screen.findByText(
      'The saved configuration changed. Check the original operation before continuing.',
    );
    expect(writes).toHaveLength(before);
    current = approvedConfig;
    fireEvent.click(button());
    await screen.findByText(/Agent added/);
    expect(writes.filter((action) => action === lostStage)).toHaveLength(1);
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/context-package')),
    ).toHaveLength(1);
  },
);
it.each([true, false])(
  'resolves a lost refresh only from exact saved admission goal proof (active=%s), then explicitly continues without refreshing again',
  async (active) => {
    const binding = {
      accountId: 'a',
      accountLabel: 'A',
      provider: 'openai-codex' as const,
      model: 'luna',
      profileRevision: 'binding-1',
    };
    const anchor: SeatConfig = {
      id: 'anchor',
      name: 'Anchor',
      role: 'agent',
      systemPrompt: '',
      color: '#335577',
      model: 'luna',
      accountBinding: binding,
      profileBinding: { profileId: 'anchor', profileRevision: '1' },
      contextGrant: { grantId: 'context', revision: 1, classification: 'personal', sourceRefs: [] },
      authorityGrant: {
        grantId: 'authority',
        revision: 1,
        filesystem: 'read',
        tools: 'read',
        network: 'restricted',
      },
      isolationRequest: { trustDomainId: 'shared', revision: 1, placement: 'reuse-compatible' },
    };
    let current: Config = {
      version: 2,
      revision: 1,
      state: 'active',
      anchorSeatId: 'anchor',
      activeSeatCap: 3,
      seats: [anchor],
      turnRules: { mode: 'directed', maxTurns: 8 },
      interceptMode: 'manual',
    };
    let members: {
      seatId: string;
      membership: {
        sessionId: string;
        seatId: string;
        generation: number;
        state: string;
        reconciliation: string;
      };
    }[] = active
      ? [
          {
            seatId: 'anchor',
            membership: {
              sessionId: 'first',
              seatId: 'anchor',
              generation: 1,
              state: 'active',
              reconciliation: 'confirmed',
            },
          },
        ]
      : [];
    let admissions: Record<string, unknown>[] = [];
    let refreshes = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/status'))
        return response({
          sessionId: session.id,
          config: current,
          runtimeAvailable: true,
          seats: members,
          admissions,
          deliveries: [],
        });
      if (path.endsWith('/context-package')) return response({ content: '' });
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (path.endsWith('/seats/revise')) {
        const { expectedRevision, seatId } = body;
        const guidance = Object.fromEntries(
          Object.entries(body).filter(
            ([key]) =>
              ![
                'expectedRevision',
                'seatId',
                'accountId',
                'contextSourceRefs',
                'sharedBoundaryAcknowledged',
                'idempotencyKey',
              ].includes(key),
          ),
        ) as SeatConfig;
        current = {
          ...current,
          revision: expectedRevision + 1,
          seats: [...current.seats, { ...guidance, id: seatId, accountBinding: binding }],
        };
        return response(current);
      }
      if (path.endsWith('/admissions/refresh')) {
        refreshes++;
        throw new Error('Refresh response lost');
      }
      if (path.endsWith('/membership')) {
        const result = {
          ...body,
          sessionId: session.id,
          generation: body.expectedGeneration + 1,
          state: 'active',
          reconciliation: 'confirmed',
        };
        members.push({ seatId: body.seatId, membership: result });
        return response(result);
      }
      if (path.endsWith('/deliveries')) return response({ ...body, sessionId: session.id });
      return response({});
    });
    const view = render(<ResponsiveChatView />);
    await start();
    await screen.findByText('Refresh response lost');
    const unchanged = structuredClone(current);
    current = { ...current, revision: current.revision + 1 };
    session.id = 'second';
    view.rerender(<ResponsiveChatView />);
    session.id = 'first';
    view.rerender(<ResponsiveChatView />);
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    const button = () => screen.getByRole('button', { name: 'Add agent and queue message' });
    const check = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
    check();
    await act(async () => {});
    expect(button()).toBeDisabled();
    current = unchanged;
    if (active) {
      const exact = {
        admissionId: 'saved',
        sessionId: 'first',
        seatId: 'anchor',
        decision: 'admitted',
        configRevision: current.revision,
        membershipGeneration: 1,
        provider: binding.provider,
        accountId: binding.accountId,
        model: binding.model,
        accountProfileRevision: binding.profileRevision,
        isolationDomainId: 'shared',
        isolationDomainRevision: 1,
        decidedAt: 1,
        idempotencyKey: 'host-admission',
        reason: null,
      };
      for (const mismatch of [
        { decision: 'refused' },
        { configRevision: 99 },
        { membershipGeneration: 99 },
        { accountId: 'other' },
        { accountProfileRevision: 'other' },
        { isolationDomainId: 'other' },
      ]) {
        admissions = [{ ...exact, ...mismatch }];
        check();
        await act(async () => {});
        expect(button()).toBeDisabled();
      }
      admissions = [exact];
      members = [
        {
          seatId: 'anchor',
          membership: {
            sessionId: 'first',
            seatId: 'anchor',
            generation: 2,
            state: 'active',
            reconciliation: 'confirmed',
          },
        },
      ];
      check();
      await act(async () => {});
      expect(button()).toBeDisabled();
      members[0].membership.generation = 1;
    }
    check();
    await waitFor(() => expect(button()).toBeEnabled());
    expect(refreshes).toBe(1);
    expect(
      screen.getByText(
        'Saved admission requirements are met. Continue the original operation explicitly.',
      ),
    ).toBeTruthy();
    fireEvent.click(button());
    await screen.findByText(/Agent added/);
    expect(refreshes).toBe(1);
  },
);

it.each(['refusal', 'malformed'] as const)(
  'handles activation %s without trusting a draft-state success',
  async (outcome) => {
    let current = { ...config, state: 'draft' };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/context-package')) return response({ content: '' });
      if (path.endsWith('/selection'))
        return response({ binding: { accountId: 'a', model: 'luna' } });
      if (path.endsWith('/config')) {
        current = JSON.parse(String(init?.body)).config;
        return response(current);
      }
      if (path.endsWith('/activate'))
        return outcome === 'refusal'
          ? new Response(
              JSON.stringify({
                error: 'Activation stopped before dispatch',
                activationMutation: 'not-started',
              }),
              { status: 409 },
            )
          : response({ ...current, revision: current.revision + 1 });
      return response({
        sessionId: session.id,
        config: current,
        runtimeAvailable: true,
        seats: [],
        deliveries: [],
      });
    });
    render(<ResponsiveChatView />);
    await start();
    await screen.findByText(
      outcome === 'refusal'
        ? 'Activation stopped before dispatch'
        : 'Configuration did not confirm the approved revision.',
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toHaveProperty(
        'disabled',
        outcome !== 'refusal',
      ),
    );
    expect(Boolean(Object.values(reviewerOperations.snapshot())[0].uncertain)).toBe(
      outcome !== 'refusal',
    );
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/activate')),
    ).toHaveLength(1);
  },
);
