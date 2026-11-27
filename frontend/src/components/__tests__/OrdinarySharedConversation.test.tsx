// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import type { CollaborationMessageInput, CollaborationProgress } from '@mitzo/protocol';
import { SharedConversationHost, SharedConversationAgents } from '../SharedConversation';
import { SymposiumConversation } from '../SymposiumConversation';
import { ChatInput } from '../ChatInput';
import { ChatInputHost } from '../ChatInputHost';
import type { ChatAreaProps } from '../ChatArea';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import {
  sharedConversationView,
  sharedReply,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { installDialogStub } from './dialog-stub';
import type { UseVoiceReturn } from '../../hooks/useVoice';

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: unknown) => unknown) => select({ connection: null }),
}));
const proof = () => 'offline-login';
const chat: ChatAreaProps = {
  sessionId: 'architect',
  messages: [
    {
      messageId: 'earlier',
      role: 'user',
      blocks: [{ blockId: 'text', blockType: 'text', content: 'Ordinary history before joining' }],
    },
  ],
  current: null,
  running: false,
  permission: null,
  onPermissionRespond: vi.fn(),
};
let polls: (() => void)[];
beforeEach(() => {
  installDialogStub();
  HTMLElement.prototype.scrollTo = vi.fn();
  polls = [];
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation((callback, timeout) => {
    if (timeout && timeout < 100)
      return setInterval(callback, timeout) as unknown as NodeJS.Timeout;
    polls.push(callback as () => void);
    return polls.length as unknown as NodeJS.Timeout;
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  singleton = false,
  ordinaryDraft?: ReturnType<typeof createChatDraft>,
  originalName?: string,
) {
  const view = sharedConversationView();
  const history: typeof view.messages = [];
  view.messages = [];
  view.policies.forEach((p) => {
    p.readsFutureDiscussion = false;
    p.repliesByDefault = false;
  });
  view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
  if (singleton) {
    view.participantSessionIds = ['architect'];
    view.joinedParticipants = [];
    view.policies = view.policies.slice(0, 1);
  }
  let failRead = false;
  let acceptSends = false;
  let deliveryStatus: 'delivered' | 'queued' | 'pending' | 'uncertain' = 'delivered';
  let releaseSend: (() => void) | undefined;
  let sendBarrier: Promise<void> | undefined;
  let delayedStatus: Promise<Response> | undefined;
  let readinessBarrier: Promise<void> | undefined;
  let progress: CollaborationProgress = {
    collaborationId: view.collaborationId,
    membershipRevision: view.membershipRevision,
    replies: [],
    refusals: [],
  };
  const sends: CollaborationMessageInput[] = [];
  const stops: CollaborationMessageInput[] = [];
  const steers: { sessionId: string; input: { requestId: string; targetCommandId: string } }[] = [];
  const agentStops: { targets: { sessionId: string; deliveryId: string; commandId: string }[] }[] =
    [];
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/events') && history.length) {
      const after = Number(new URL(url, 'http://offline').searchParams.get('after'));
      const page = history.filter((message) => message.sequence > after).slice(0, 50);
      const cursor = page.at(-1)?.sequence ?? after;
      return Response.json({
        events: page.map((message) => ({
          version: 1,
          collaborationId: view.collaborationId,
          eventId: uuid(900 + message.sequence),
          sequence: message.sequence,
          change: { kind: 'message', message },
        })),
        cursor,
        highWatermark: view.cursor,
        hasMore: cursor < view.cursor,
      });
    }
    if (url.endsWith('/codex-queue/steer')) {
      const input = JSON.parse(init!.body as string);
      steers.push({ sessionId: url.split('/')[3], input });
      return Response.json({ requestId: input.requestId, status: 'accepted' });
    }
    if (url.endsWith('/agents/stop')) {
      const input = JSON.parse(init!.body as string);
      agentStops.push(input);
      return Response.json({
        requestId: input.requestId,
        recipients: input.targets.map((target: { sessionId: string; deliveryId: string }) => ({
          sessionId: target.sessionId,
          deliveryId: target.deliveryId,
          status: 'requested',
        })),
      });
    }
    if (url.includes('/telos/work/links') || url.includes('/symposium/profile-proposals'))
      return Response.json([]);
    if (url.includes('/symposium/status'))
      return delayedStatus ?? Response.json({ sessionId: 'architect', config: null, seats: [] });
    if (url.includes('source-setup'))
      return Response.json({
        state: 'selected',
        sourceConversationId: 'architect',
        collaboration: {
          version: 1,
          collaborationId: view.collaborationId,
          revision: view.membershipRevision,
          participantSessionIds: view.participantSessionIds,
        },
      });
    if (url.endsWith('/conversation')) {
      if (failRead) throw Error('Offline: retained discussion read failed');
      return Response.json(view);
    }
    if (url.endsWith('/progress')) return Response.json(progress);
    if (url.includes('/recipients/')) {
      await readinessBarrier;
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: decodeURIComponent(url.split('/').at(-1)!),
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready: true,
        reason: null,
      });
    }
    if (url.endsWith('/messages/observe')) return Response.json({ message: null, terminal: false });
    if (url.endsWith('/messages/stop')) {
      const input = JSON.parse(init!.body as string);
      stops.push(input);
      return Response.json({ requestId: input.requestId, recipients: [] });
    }
    if (url.endsWith('/messages')) {
      const input = JSON.parse(init!.body as string) as CollaborationMessageInput;
      sends.push(input);
      if (acceptSends) {
        await sendBarrier;
        const ids =
          input.responders.kind === 'selected' ? input.responders.sessionIds : ['architect'];
        const receipt = {
          ...sharedConversationView().messages[0],
          messageId: input.requestId,
          projectionId: input.requestId,
          text: input.text,
          images: input.images,
          snapshot: input.snapshot,
          responders: ids,
          readers: ids,
          policySequence: input.expectedPolicySequence,
          settings: Object.fromEntries(
            ids.map((id) => [id, sharedConversationView().messages[0].settings[id]]),
          ),
          policyRevisions: Object.fromEntries(ids.map((id) => [id, 0])),
          membershipRevision: input.expectedMembershipRevision,
          deliveries: sharedConversationView()
            .messages[0].deliveries.filter((d) => ids.includes(d.sessionId))
            .map((d) => ({ ...d, status: deliveryStatus, reason: null })),
        };
        view.messages.push(receipt);
        return Response.json(receipt);
      }
      throw Error('Original send acknowledgement lost');
    }
    throw Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', transport);
  const api = new MitzoApiClient(transport);
  const ordinarySend = vi.fn(() => false),
    ordinaryStop = vi.fn();
  const voice: UseVoiceReturn = {
    available: true,
    recording: false,
    transcribing: false,
    partialTranscript: '',
    micBlocked: false,
    error: null,
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => 'Retained voice input'),
    cancelRecording: vi.fn(),
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: 'offline',
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    setVoice: vi.fn(),
  };
  const tree = (source = chat, layout = 'phone', ordinaryConfirmed = true) => (
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={api}
        clientId="client"
        authScope={proof()}
        getVerifiedAuthScope={proof}
      >
        <ChatInputHost sessionId="architect">
          {originalName && (
            <SharedConversationAgents
              compact
              scope="architect"
              messages={[]}
              agents={[{ id: 'architect', name: originalName, state: 'Current conversation' }]}
            />
          )}
          <SymposiumConversation
            key={layout}
            sessionId="architect"
            ordinaryConfirmed={ordinaryConfirmed}
            chat={source}
            profileToolsTarget={null}
            ordinaryComposer={
              <div className="conversation-composer">
                <ChatInput
                  sessionId="architect"
                  voice={voice}
                  tokenState={{
                    agentContext: 5000,
                    contextCeiling: 200000,
                    sessionTotal: 9000,
                    numTurns: 2,
                    turnIndex: 1,
                    numCompactions: 0,
                  }}
                  savedChatDraft={ordinaryDraft}
                  composerCapabilities={{
                    commands: 'ordinary',
                    terminalHref: '/terminal?sessionId=architect',
                  }}
                  initialText="Ordinary draft before joining"
                  onSend={ordinarySend}
                  onStop={ordinaryStop}
                  running={source.running}
                />
              </div>
            }
          />
        </ChatInputHost>
      </SharedConversationHost>
    </MemoryRouter>
  );
  return {
    view,
    history,
    tree,
    sends,
    stops,
    steers,
    agentStops,
    transport,
    ordinarySend,
    ordinaryStop,
    voice,
    delayReadiness: () => {
      let release!: () => void;
      readinessBarrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    delaySend: (status: typeof deliveryStatus = 'delivered') => {
      acceptSends = true;
      deliveryStatus = status;
      sendBarrier = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      return () => releaseSend?.();
    },
    delayStatus: () => {
      let release!: (value: Response) => void;
      delayedStatus = new Promise<Response>((resolve) => {
        release = resolve;
      });
      return () => release(Response.json({ sessionId: 'architect', config: null, seats: [] }));
    },
    fail: () => {
      failRead = true;
    },
    setProgress: (value: CollaborationProgress) => {
      progress = value;
    },
    join: () => {
      view.participantSessionIds = ['architect', 'reviewer'];
      view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
      view.membershipRevision++;
      view.policies = sharedConversationView()
        .policies.slice(0, 2)
        .map((p) => ({
          ...p,
          membershipRevision: view.membershipRevision,
          readsFutureDiscussion: false,
          repliesByDefault: false,
        }));
      progress = { ...progress, membershipRevision: view.membershipRevision };
    },
  };
}

it.each(['Send message', 'Queue message'])(
  'one %s press survives shared readiness without ordinary fallback',
  async (action) => {
    const draft = { ...createChatDraft(), text: 'Original shared draft' };
    saveChatDraft(draft);
    const f = fixture(false, draft, 'Architect');
    const ready = f.delayReadiness();
    const accepted = f.delaySend('queued');
    render(f.tree({ ...chat, running: action === 'Queue message' }));
    await screen.findByRole('button', { name: 'Choose who replies' });
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'One press before readiness settles' } });
    const button = screen.getByRole('button', { name: action });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    fireEvent.click(button);
    expect(f.sends).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'Keep the next draft' } });
    await act(async () => ready());
    await waitFor(() => expect(f.sends).toHaveLength(1));
    expect(f.sends[0].text).toBe('One press before readiness settles');
    expect(f.sends[0].responders).toEqual({ kind: 'selected', sessionIds: ['architect'] });
    await act(async () => accepted());
    await waitFor(() =>
      expect(
        getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend?.acknowledged,
      ).toBe(true),
    );
    expect(input).toHaveProperty('value', 'Keep the next draft');
    expect(f.ordinarySend).not.toHaveBeenCalled();
    expect(f.steers).toHaveLength(0);
  },
);

it.each(['delivered', 'queued', 'pending', 'uncertain'] as const)(
  'clears an accepted shared prompt with %s delivery and retains a newer draft',
  async (status) => {
    for (const edited of [false, true]) {
      const draft = { ...createChatDraft(), text: 'Original shared prompt' };
      saveChatDraft(draft);
      const f = fixture(false, draft, 'Architect');
      const release = f.delaySend(status);
      const rendered = render(f.tree());
      await screen.findByRole('button', { name: 'Choose who replies' });
      const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
      fireEvent.change(input, { target: { value: 'Send this prompt' } });
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(f.sends).toHaveLength(1));
      expect(input).toHaveProperty('value', '');
      if (edited) fireEvent.change(input, { target: { value: 'Keep this newer draft' } });
      await act(async () => release());
      await waitFor(() =>
        expect(
          getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend?.acknowledged,
        ).toBe(true),
      );
      expect(input).toHaveProperty('value', edited ? 'Keep this newer draft' : '');
      expect(getChatDraft(draft.id)?.text ?? '').toBe(edited ? 'Keep this newer draft' : '');
      rendered.unmount();
      localStorage.clear();
      sessionStorage.clear();
    }
  },
);

it.each([false, true])(
  'accepts the original composer revision after recipients change, with newer draft: %s',
  async (edited) => {
    const draft = { ...createChatDraft(), text: 'Original shared prompt' };
    saveChatDraft(draft);
    const f = fixture(false, draft, 'Architect');
    const release = f.delaySend('pending');
    render(f.tree());
    fireEvent.click(await screen.findByRole('button', { name: 'Choose who replies' }));
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'Send this prompt' } });
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(f.sends).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Architect' }));
    if (edited) fireEvent.change(input, { target: { value: 'Keep this newer draft' } });
    await act(async () => release());
    await waitFor(() =>
      expect(
        getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend?.acknowledged,
      ).toBe(true),
    );
    expect(input).toHaveProperty('value', edited ? 'Keep this newer draft' : '');
    expect(getChatDraft(draft.id)?.text ?? '').toBe(edited ? 'Keep this newer draft' : '');
    expect(f.sends).toHaveLength(1);
  },
);

it('keeps the original named agent as the explicit initial recipient', async () => {
  const f = fixture(false, undefined, 'Original architect');
  render(f.tree());
  const trigger = await screen.findByRole('button', { name: 'Choose who replies' });
  await waitFor(() => expect(trigger.title).toContain('Original architect'));
  expect(trigger.textContent).toBe('@');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  expect(
    screen.getByRole('button', { name: 'Original architect' }).getAttribute('aria-pressed'),
  ).toBe('true');
  expect(screen.getByRole('button', { name: 'Reviewer' }).getAttribute('aria-pressed')).toBe(
    'false',
  );
  expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
  expect(f.sends).toHaveLength(0);
});

it.each([false, true])(
  'uses targeted Stop and Steer after reopening with paged history: %s',
  async (paged) => {
    const f = fixture(false, undefined, 'Architect');
    f.view.messages = [structuredClone(sharedConversationView().messages[0])];
    f.view.messages[0].deliveries
      .filter((delivery) => delivery.purpose === 'reply')
      .forEach((delivery) => {
        delivery.status = 'delivered';
        delivery.reason = null;
      });
    if (paged) {
      f.history.push(
        f.view.messages[0],
        ...Array.from({ length: 50 }, (_, index) => ({
          ...structuredClone(sharedReply),
          messageId: uuid(100 + index),
          projectionId: uuid(200 + index),
          sequence: index + 2,
          text: `Later reply ${index}`,
          deliveries: [],
        })),
      );
      f.view.messages = f.history.slice(-50);
      f.view.hasEarlierMessages = true;
      f.view.cursor = 51;
    }
    const source = {
      ...chat,
      running: true,
      messages: [
        ...chat.messages,
        {
          messageId: 'ordinary-architect',
          role: 'user' as const,
          commandState: 'running' as const,
          blocks: [
            { blockId: 'active', blockType: 'text' as const, content: 'Original active request' },
          ],
        },
      ],
    };
    render(f.tree(source));
    await screen.findByRole('group', { name: 'Reply recipients' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' });
    fireEvent.change(input, { target: { value: 'Check the UI before continuing' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Steer Architect, Reviewer' }));
    await waitFor(() => expect(f.steers).toHaveLength(2));
    expect(f.steers.map((request) => request.sessionId)).toEqual(['architect', 'reviewer']);
    expect(new Set(f.steers.map((request) => request.input.targetCommandId)).size).toBe(2);
    expect(screen.queryByRole('button', { name: 'Stop original agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Send to / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Steer Architect, Reviewer' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Stop Architect, Reviewer' }).textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Stop Architect, Reviewer' }));
    await waitFor(() => expect(f.agentStops).toHaveLength(2));
    expect(
      f.agentStops.flatMap((request) => request.targets.map((target) => target.sessionId)),
    ).toEqual(['architect', 'reviewer']);
    expect(f.ordinaryStop).not.toHaveBeenCalled();
    expect(f.sends).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
  },
);

it('retains the original context wheel, microphone and resource controls through sharing and responsive qualification', async () => {
  const f = fixture(true, undefined, 'Architect');
  const h = render(f.tree());
  const input = screen.getByRole('textbox');
  const wheel = screen.getByRole('button', { name: 'Token usage' });
  const mic = screen.getByRole('button', { name: 'Record voice message' });
  f.join();
  await poll();
  const recipients = await screen.findByRole('button', { name: 'Choose who replies' });
  expect(recipients.textContent).toBe('@');
  fireEvent.click(recipients);
  fireEvent.click(screen.getByRole('button', { name: 'Architect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
  const release = f.delayStatus();
  h.rerender(f.tree({ ...chat, running: true }, 'desktop', false));
  expect(screen.getByRole('textbox')).toBe(input);
  const sharedWheel = screen.getByRole('button', { name: 'Token usage' });
  expect(sharedWheel.classList.contains('conversation-context-wheel')).toBe(true);
  expect(sharedWheel).not.toBe(wheel);
  expect(screen.getByRole('button', { name: 'Record voice message' })).toBe(mic);
  fireEvent.click(sharedWheel);
  const contextDialog = screen.getByRole('dialog', { name: 'Context by agent' });
  expect(within(contextDialog).getByText('Architect')).toBeTruthy();
  expect(within(contextDialog).getByText('Reviewer')).toBeTruthy();
  fireEvent.click(within(contextDialog).getByRole('button', { name: 'Close' }));
  fireEvent.click(mic);
  expect(f.voice.startRecording).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Terminal' })).toBeTruthy();
  release();
  await poll();
  expect(f.sends).toHaveLength(0);
  expect(f.ordinarySend).not.toHaveBeenCalled();
});

it('keeps canonical Symposium identity on the same Agents trigger through joining and roster loss', async () => {
  const f = fixture(true, undefined, 'Original architect');
  render(f.tree());
  const original = await screen.findByRole('button', { name: 'Agents, Original architect' });
  expect(original.querySelector('.conversation-participant-names')).toBeNull();
  f.join();
  await poll();
  const shared = await screen.findByRole('button', {
    name: 'Agents, Original architect, Reviewer',
  });
  expect(shared).toBe(original);
  expect(within(shared).getByText('Symposium · 2 agents')).toBeTruthy();
  fireEvent.click(shared);
  expect(screen.getAllByRole('dialog', { name: 'Agents' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  f.view.participantSessionIds = ['architect'];
  f.view.membershipRevision++;
  f.view.joinedParticipants = [];
  await poll();
  await screen.findByText('Symposium · 1 agent');
  expect(shared.closest('.conversation-agents-entry--named')).not.toBeNull();
  expect(shared.closest('.conversation-participants-container')).toBeNull();
  expect(screen.getAllByRole('textbox', { name: 'Message Mitzo' })).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
});

it('retains the last canonical header count with an explicit stale state after a failed refresh', async () => {
  const f = fixture(false, undefined, 'Original architect');
  render(f.tree());
  await screen.findByText('Symposium · 3 agents');
  f.fail();
  await poll();
  expect(screen.getByText('Symposium · 3 agents')).toBeTruthy();
  expect(screen.getByLabelText('Agent membership could not be refreshed')).toBeTruthy();
});

it('uses the canonical roster while history loads and restores the same shared identity after reopening', async () => {
  const f = fixture(true, undefined, 'Original architect');
  f.view.membershipRevision = 3; // A prior shared discussion, now one remaining member.
  const originalTransport = f.transport.getMockImplementation()!;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.transport.mockImplementation(async (url, init) => {
    if (url.endsWith('/conversation')) await barrier;
    return originalTransport(url, init);
  });
  const mounted = render(f.tree());
  await screen.findByText('Symposium · 1 agent');
  expect(screen.getByLabelText('Agent membership is refreshing')).toBeTruthy();
  const trigger = screen.getByRole('button', { name: 'Agents, Original architect' });
  expect(trigger.getAttribute('data-discussion-id')).toBe(f.view.collaborationId);
  await act(async () => release());
  await waitFor(() => expect(screen.queryByLabelText('Agent membership is refreshing')).toBeNull());
  mounted.unmount();
  render(f.tree());
  await screen.findByText('Symposium · 1 agent');
  expect(
    screen
      .getByRole('button', { name: 'Agents, Original architect' })
      .getAttribute('data-discussion-id'),
  ).toBe(f.view.collaborationId);
  expect(f.transport.mock.calls.some(([url]) => url.endsWith('/begin'))).toBe(false);
  expect(f.sends).toHaveLength(0);
});

it('retains the shared composer and transcript while a resized page requalifies ordinary status', async () => {
  const f = fixture();
  const { container, rerender } = render(f.tree());
  await screen.findByRole('button', { name: 'Choose who replies' });
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Draft while changing responsive owners' } });
  input.focus();
  input.setSelectionRange(4, 10);
  const release = f.delayStatus();
  rerender(f.tree(chat, 'desktop', false));
  expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
  expect(input.value).toBe('Draft while changing responsive owners');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([4, 10]);
  expect(container.querySelectorAll('.chat-messages')).toHaveLength(1);
  expect(screen.getByText('Ordinary history before joining')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose who replies' })).toBeTruthy();
  expect(f.sends).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  fireEvent.click(screen.getByRole('button', { name: 'Current agent' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Current agent' }).getAttribute('aria-pressed')).toBe(
      'false',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reviewer' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(f.sends).toHaveLength(1));
  expect(f.sends[0].responders).toEqual({ kind: 'selected', sessionIds: ['reviewer'] });
  await act(async () => release());
  expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
});
async function poll() {
  await act(async () => {
    for (const callback of [...polls]) callback();
  });
}

it('keeps the actual ordinary transcript and composer mounted through joining and source activity', async () => {
  const f = fixture(true);
  const { container, rerender } = render(f.tree());
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  const transcript = container.querySelector('.chat-messages');
  fireEvent.change(input, { target: { value: 'Edited before the reviewer joins' } });
  await waitFor(() =>
    expect(
      JSON.stringify(f.transport.mock.calls.map(([url]) => url)),
      JSON.stringify(f.transport.mock.calls.map(([url]) => url)),
    ).toContain('/progress'),
  );
  f.join();
  await poll();
  const recipients = await screen.findByRole('button', { name: 'Choose who replies' });
  expect(container.querySelectorAll('.chat-messages')).toHaveLength(1);
  expect(container.querySelector('.chat-messages')).toBe(transcript);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input.value).toBe('Edited before the reviewer joins');
  expect(recipients.title).toContain('Current agent');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  rerender(f.tree({ ...chat, running: true }));
  expect(screen.getByRole('textbox')).toBe(input);
  expect(screen.getByRole('button', { name: 'Choose who replies' })).toBe(recipients);
  expect(screen.getByRole('button', { name: 'Queue message' }).hasAttribute('disabled')).toBe(
    false,
  );
  expect(screen.getByText('Ordinary history before joining')).toBeTruthy();
  expect(
    f.transport.mock.calls
      .filter(([url]) => url.includes('/session-collaborations/'))
      .every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('retains ordinary attachment previews and enables screenshot delivery while keeping Terminal navigation', async () => {
  const draft = {
    ...createChatDraft(),
    text: 'Draft with retained attachment',
    images: [{ data: 'YQ==', preview: 'data:image/png;base64,YQ==', mediaType: 'image/png' }],
  };
  saveChatDraft(draft);
  const f = fixture(true, draft);
  render(f.tree());
  const input = screen.getByRole('textbox');
  const image = screen.getByRole('img', { name: 'Attachment 1' });
  await waitFor(() =>
    expect(f.transport.mock.calls.some(([url]) => url.endsWith('/progress'))).toBe(true),
  );
  f.join();
  await poll();
  await screen.findByRole('button', { name: 'Choose who replies' });
  expect(screen.getByRole('textbox')).toBe(input);
  expect(screen.getByRole('img', { name: 'Attachment 1' })).toBe(image);
  expect(
    screen.queryByText(/This shared route supports text and reviewed prompt context/),
  ).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect(screen.queryByRole('button', { name: 'Refresh conversation' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Terminal' }).getAttribute('href')).toBe(
    '/terminal?sessionId=architect',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect((input as HTMLTextAreaElement).value).toBe('Draft with retained attachment');
  expect(f.sends).toHaveLength(0);
});

it('merges rich original history, source echoes and authorized live/final replies exactly once by identity', async () => {
  const f = fixture();
  f.view.messages = [
    structuredClone(sharedReply),
    {
      ...structuredClone(sharedReply),
      messageId: '00000000-0000-4000-8000-000000000090',
      projectionId: '00000000-0000-4000-8000-000000000091',
      sequence: 3,
      author: { sessionId: 'reviewer' },
      source: { ...sharedReply.source!, conversationId: 'reviewer' },
    },
  ];
  const rich = {
    ...chat,
    messages: [
      ...chat.messages,
      {
        messageId: 'final-answer',
        replyToMessageId: 'ordinary-architect',
        role: 'assistant' as const,
        blocks: [
          { blockId: 'text', blockType: 'text' as const, content: sharedReply.text },
          {
            blockId: 'tool',
            blockType: 'tool_use' as const,
            toolId: 'lookup',
            toolName: 'Read',
            content: '',
            toolResult: 'Rich source result',
          },
        ],
      },
    ],
  };
  const { container } = render(f.tree(rich));
  await screen.findByRole('button', { name: 'Choose who replies' });
  expect(container.querySelectorAll('.chat-messages')).toHaveLength(1);
  // Equal text in distinct source conversations is two messages. Only the exact source echo collapses.
  expect(screen.getAllByText(sharedReply.text)).toHaveLength(2);
  expect(screen.getByText('Ordinary history before joining')).toBeTruthy();
  expect(container.innerHTML).toContain('Read');
  expect(screen.getByLabelText('Message details for Reviewer')).toBeTruthy();
});

it.each(['selected', 'default'] as const)(
  'preserves saved %s empty intent and focuses inline recipients as its recovery action',
  async (kind) => {
    const f = fixture();
    saveChatDraft({
      ...createChatDraft(),
      id: 'shared:' + f.view.collaborationId,
      settings: {
        ...createChatDraft().settings,
        collaborationResponders: {
          collaborationId: f.view.collaborationId,
          responders: kind === 'selected' ? { kind, sessionIds: [] } : { kind },
        },
      },
    });
    render(f.tree());
    const trigger = (await screen.findAllByRole('button', { name: 'Choose who replies' })).find(
      (button) => button.getAttribute('data-responder-trigger') === 'inline',
    )!;
    expect(
      getChatDraft('shared:' + f.view.collaborationId)?.settings.collaborationResponders
        ?.responders,
    ).toEqual(kind === 'selected' ? { kind, sessionIds: [] } : { kind });
    // Recovery in the status surface must choose recipients, not perform an unrelated refresh.
    const choose = await screen.findAllByRole('button', { name: 'Choose who replies' });
    expect(choose.length).toBeGreaterThan(1);
    fireEvent.click(choose.find((button) => button !== trigger)!);
    const picker = screen.getByRole('group', { name: 'Reply recipients' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Current agent' }));
    expect(screen.queryByRole('group', { name: 'Who replies to this prompt' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(f.sends).toHaveLength(1));
    expect(f.sends[0].responders).toEqual({ kind: 'selected', sessionIds: ['architect'] });
    expect(f.ordinarySend).not.toHaveBeenCalled();
    const identity = f.sends[0].requestId;
    f.fail();
    fireEvent.click(await screen.findByRole('button', { name: 'Check original request' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
    await waitFor(() =>
      expect(screen.getByText('Offline: retained discussion read failed')).toBeTruthy(),
    );
    expect(
      getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend?.input.requestId,
    ).toBe(identity);
    expect(f.sends).toHaveLength(1);
  },
);

it('keeps explicit routing and retained send/Stop identity when the selected participant leaves', async () => {
  const f = fixture();
  saveChatDraft({
    ...createChatDraft(),
    id: 'shared:' + f.view.collaborationId,
    settings: {
      ...createChatDraft().settings,
      collaborationResponders: {
        collaborationId: f.view.collaborationId,
        responders: { kind: 'selected', sessionIds: ['reviewer'] },
      },
    },
  });
  const h = render(f.tree());
  await screen.findByRole('button', { name: 'Choose who replies' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  const input = screen.getByRole('textbox');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(f.sends).toHaveLength(1));
  const original = structuredClone(f.sends[0]);
  f.view.participantSessionIds = ['architect'];
  f.view.joinedParticipants = [];
  f.view.membershipRevision++;
  f.view.policies = f.view.policies
    .slice(0, 1)
    .map((policy) => ({ ...policy, membershipRevision: f.view.membershipRevision }));
  f.setProgress({
    collaborationId: f.view.collaborationId,
    membershipRevision: f.view.membershipRevision,
    replies: [],
    refusals: [],
  });
  await poll();
  h.rerender(f.tree({ ...chat, running: true }));
  expect(screen.getByRole('textbox')).toBe(input);
  expect(screen.getByRole('button', { name: 'Choose who replies' }).title).toContain('Unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Choose who replies' }));
  fireEvent.click(screen.getByRole('button', { name: 'Current agent' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Stop .*Current agent/ })).toBeTruthy(),
  );
  expect(screen.queryByRole('button', { name: 'Stop original agent' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Stop generation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Stop .*Current agent/ }));
  await waitFor(() => expect(f.stops).toEqual([original]));
  expect(f.ordinaryStop).toHaveBeenCalledOnce();
  expect(getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend).toMatchObject({
    input: original,
    stopRequested: true,
  });
  expect(f.sends).toHaveLength(1);
});
