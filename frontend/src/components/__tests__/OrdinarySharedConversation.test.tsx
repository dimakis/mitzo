// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import type { CollaborationMessageInput, CollaborationProgress } from '@mitzo/protocol';
import { SharedConversationHost } from '../SharedConversation';
import { SymposiumConversation } from '../SymposiumConversation';
import { ChatInput } from '../ChatInput';
import { ChatInputHost } from '../ChatInputHost';
import type { ChatAreaProps } from '../ChatArea';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import {
  sharedConversationView,
  sharedReply,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { installDialogStub } from './dialog-stub';

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
    if (timeout && timeout < 100) return setInterval(callback, timeout);
    polls.push(callback as () => void);
    return polls.length;
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(singleton = false, ordinaryDraft?: ReturnType<typeof createChatDraft>) {
  const view = sharedConversationView();
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
  let delayedStatus: Promise<Response> | undefined;
  let progress: CollaborationProgress = {
    collaborationId: view.collaborationId,
    membershipRevision: view.membershipRevision,
    replies: [],
    refusals: [],
  };
  const sends: CollaborationMessageInput[] = [];
  const stops: CollaborationMessageInput[] = [];
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
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
    if (url.includes('/recipients/'))
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: decodeURIComponent(url.split('/').at(-1)!),
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready: true,
        reason: null,
      });
    if (url.endsWith('/messages/observe')) return Response.json({ message: null, terminal: false });
    if (url.endsWith('/messages/stop')) {
      const input = JSON.parse(init!.body as string);
      stops.push(input);
      return Response.json({ requestId: input.requestId, recipients: [] });
    }
    if (url.endsWith('/messages')) {
      sends.push(JSON.parse(init!.body as string));
      throw Error('Original send acknowledgement lost');
    }
    throw Error('Unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', transport);
  const api = new MitzoApiClient(transport);
  const ordinarySend = vi.fn(() => false),
    ordinaryStop = vi.fn();
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
    tree,
    sends,
    stops,
    transport,
    ordinarySend,
    ordinaryStop,
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Current agent' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('checkbox', { name: 'Current agent' }) as HTMLInputElement).checked,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done choosing replies' }));
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
  expect(recipients.textContent).toContain('Current agent');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  rerender(f.tree({ ...chat, running: true }));
  expect(screen.getByRole('textbox')).toBe(input);
  expect(screen.getByRole('button', { name: 'Choose who replies' })).toBe(recipients);
  expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByText('Ordinary history before joining')).toBeTruthy();
  expect(
    f.transport.mock.calls
      .filter(([url]) => url.includes('/session-collaborations/'))
      .every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('retains ordinary attachments with a precise shared-route limitation and keeps Terminal navigation', async () => {
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
  await screen.findByText(/This shared route supports text and reviewed prompt context/);
  expect(screen.getByRole('button', { name: 'Send message' }).hasAttribute('disabled')).toBe(true);
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
  'preserves saved %s empty intent and opens the picker as its recovery action',
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
      (button) => button.classList.contains('composer-responders-trigger'),
    )!;
    expect(
      getChatDraft('shared:' + f.view.collaborationId)?.settings.collaborationResponders
        ?.responders,
    ).toEqual(kind === 'selected' ? { kind, sessionIds: [] } : { kind });
    // Recovery in the status surface must choose recipients, not perform an unrelated refresh.
    const choose = await screen.findAllByRole('button', { name: 'Choose who replies' });
    expect(choose.length).toBeGreaterThan(1);
    fireEvent.click(choose.find((button) => button !== trigger)!);
    const picker = screen.getByRole('group', { name: 'Who replies to this prompt' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Current agent' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Done choosing replies' }));
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
  expect(screen.getByRole('button', { name: 'Choose who replies' }).textContent).toContain(
    'Unavailable',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop generation' }));
  await waitFor(() => expect(f.stops).toEqual([original]));
  expect(f.ordinaryStop).not.toHaveBeenCalled();
  expect(getChatDraft('shared:' + f.view.collaborationId)?.collaborationSend).toMatchObject({
    input: original,
    stopRequested: true,
  });
  expect(f.sends).toHaveLength(1);
});
