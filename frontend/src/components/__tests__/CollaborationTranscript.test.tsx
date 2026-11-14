// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  createCollaborationProjection,
  applyCollaborationEvents,
  TelosWorkApiClient,
} from '@mitzo/client';
import { CollaborationTranscript } from '../CollaborationTranscript';
import type { ChatAreaProps } from '../ChatArea';
import type { FinishedMessage, StreamingMessage } from '@mitzo/protocol';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

// jsdom does not implement the browser scrollTo method used by the real ChatArea.
const originalScrollTo = Element.prototype.scrollTo;
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollTo = originalScrollTo;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const names = { architect: 'Architect', reviewer: 'Reviewer', reader: 'Reader' };
const sourceChat = (
  messages: FinishedMessage[],
  current: StreamingMessage | null = null,
): ChatAreaProps => ({
  sessionId: 'architect',
  messages,
  current,
  running: !!current,
  permission: null,
  onPermissionRespond: () => {},
});
const sourceStream = (commandId: string): StreamingMessage => ({
  messageId: 'source-live',
  replyToMessageId: commandId,
  startedSeq: 1000,
  blocks: new Map([
    ['text', { blockId: 'text', blockType: 'text', content: 'Same visible body', done: false }],
  ]),
  blockOrder: ['text'],
});

it('suppresses a native delivery packet while retaining each operator body and projection identity', () => {
  const view = sharedConversationView();
  view.messages = [
    { ...sharedPrompt, text: 'Earlier operator body' },
    {
      ...sharedPrompt,
      messageId: uuid(80),
      projectionId: uuid(81),
      sequence: 2,
      text: 'Latest operator body',
    },
  ];
  const { container } = render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([
          {
            messageId: 'ordinary-architect',
            role: 'user',
            blocks: [
              {
                blockId: 'packet',
                blockType: 'text',
                content: 'Internal delivery instructions and discussion JSON',
              },
            ],
          },
        ])}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByText('Internal delivery instructions and discussion JSON')).toBeNull();
  expect(screen.getAllByText('Earlier operator body')).toHaveLength(1);
  expect(screen.getAllByText('Latest operator body')).toHaveLength(1);
  expect(container.querySelectorAll(`[data-command-request="${uuid(3)}"]`)).toHaveLength(1);
  expect(container.querySelectorAll(`[data-command-request="${uuid(81)}"]`)).toHaveLength(1);
});

it('anchors unfinished source reconciliation and tool-only messages after their shared command', () => {
  const view = sharedConversationView();
  view.messages = [sharedPrompt];
  const finalized: FinishedMessage = {
    messageId: sharedReply.source!.messageId,
    replyToMessageId: sharedReply.source!.commandId,
    role: 'assistant',
    blocks: [{ blockId: 'text', blockType: 'text', content: sharedReply.text }],
  };
  const tool: FinishedMessage = {
    messageId: 'tool-only',
    replyToMessageId: 'ordinary-architect',
    role: 'assistant',
    blocks: [{ blockId: 'text', blockType: 'text', content: 'Retained ordinary tool observation' }],
  };
  const tree = () => (
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([tool, finalized])}
      />
    </MemoryRouter>
  );
  const { container, rerender } = render(tree());
  const order = () => container.querySelector('.chat-messages')!.textContent!;
  expect(order().indexOf(sharedPrompt.text)).toBeLessThan(
    order().indexOf('Retained ordinary tool observation'),
  );
  expect(order().indexOf('Retained ordinary tool observation')).toBeLessThan(
    order().indexOf(sharedReply.text),
  );
  view.messages.push(sharedReply);
  rerender(tree());
  expect(order().indexOf(sharedPrompt.text)).toBeLessThan(
    order().indexOf('Retained ordinary tool observation'),
  );
  expect(order().indexOf('Retained ordinary tool observation')).toBeLessThan(
    order().indexOf(sharedReply.text),
  );
  expect(screen.getAllByText(sharedReply.text)).toHaveLength(1);
});

it('deduplicates ordinary finished/live source echoes using command identity without collapsing equal reviewer text', () => {
  const view = sharedConversationView();
  view.messages = [view.messages[0]];
  const progress = {
    collaborationId: view.collaborationId,
    membershipRevision: view.membershipRevision,
    replies: [
      {
        projectionId: uuid(98),
        sourceMessageId: 'source-live',
        deliveryId: uuid(4),
        sessionId: 'architect',
        text: 'Same visible body',
      },
      {
        projectionId: uuid(99),
        sourceMessageId: 'source-live',
        deliveryId: uuid(5),
        sessionId: 'reviewer',
        text: 'Same visible body',
      },
    ],
    refusals: [],
  };
  const stream = sourceStream('ordinary-architect');
  const tree = (ordinary: ChatAreaProps) => (
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={ordinary}
        progress={progress}
        names={names}
      />
    </MemoryRouter>
  );
  const h = render(tree(sourceChat([], stream)));
  expect(screen.getAllByText('Same visible body')).toHaveLength(2);
  expect(screen.getByLabelText('Message details for Architect')).toBeTruthy();
  expect(screen.getByLabelText('Message details for Reviewer')).toBeTruthy();
  // Ordinary finalization may precede the shared receipt. The old live sample
  // must not duplicate a rich source body while the projection catches up.
  h.rerender(
    tree(
      sourceChat([
        {
          messageId: stream.messageId,
          replyToMessageId: stream.replyToMessageId,
          role: 'assistant',
          blocks: [{ blockId: 'text', blockType: 'text', content: 'Same visible body' }],
        },
      ]),
    ),
  );
  expect(screen.getAllByText('Same visible body')).toHaveLength(2);
  // Reusing a source message ID under another command is distinct work.
  h.rerender(tree(sourceChat([], sourceStream('different-command'))));
  expect(screen.getAllByText('Same visible body')).toHaveLength(3);
});

it('keeps ordinary prefix order and shared sequence order despite unrelated source cursors and timestamps', () => {
  const view = sharedConversationView();
  const prefix = {
    messageId: 'prefix',
    role: 'user' as const,
    startedSeq: 9000,
    timestamp: 999999,
    blocks: [{ blockId: 'text', blockType: 'text' as const, content: 'Ordinary prefix' }],
  };
  const rich = {
    messageId: sharedReply.source!.messageId,
    replyToMessageId: sharedReply.source!.commandId,
    role: 'assistant' as const,
    startedSeq: 10000,
    timestamp: 1,
    blocks: [{ blockId: 'text', blockType: 'text' as const, content: sharedReply.text }],
  };
  const { container } = render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([prefix, rich])}
        names={names}
      />
    </MemoryRouter>,
  );
  const text = container.querySelector('.chat-messages')!.textContent!;
  expect(text.indexOf('Ordinary prefix')).toBeLessThan(text.indexOf(view.messages[0].text));
  expect(text.indexOf(view.messages[0].text)).toBeLessThan(text.indexOf(sharedReply.text));
  expect(screen.getAllByText(sharedReply.text)).toHaveLength(1);
});
it('attributes live visible text and preserves finalized answers beside a live source refusal', () => {
  const view = sharedConversationView();
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        names={names}
        progress={{
          collaborationId: view.collaborationId,
          membershipRevision: view.membershipRevision,
          replies: [
            {
              projectionId: uuid(98),
              sourceMessageId: 'live-reviewer',
              deliveryId: uuid(5),
              sessionId: 'reviewer',
              text: 'Live reviewer text',
            },
          ],
          refusals: [{ deliveryId: uuid(5), sessionId: 'reviewer', code: 'capacity_refused' }],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Live reviewer text')).toBeTruthy();
  expect(screen.getByLabelText('Message details for Reviewer')).toBeTruthy();
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Reviewer: The live reply is too large');
});
it('suppresses exactly a finalized source while another live source for the same delivery stays visible', () => {
  const view = sharedConversationView();
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        names={names}
        progress={{
          collaborationId: view.collaborationId,
          membershipRevision: view.membershipRevision,
          replies: [
            {
              projectionId: uuid(98),
              sourceMessageId: sharedReply.source!.messageId,
              deliveryId: sharedReply.replyToDeliveryId!,
              sessionId: 'architect',
              text: sharedReply.text,
            },
            {
              projectionId: uuid(99),
              sourceMessageId: 'later-source',
              deliveryId: sharedReply.replyToDeliveryId!,
              sessionId: 'architect',
              text: 'A different live message',
            },
          ],
          refusals: [],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getAllByText(sharedReply.text)).toHaveLength(1);
  expect(screen.getByText('A different live message')).toBeTruthy();
});
it('never queries ordinary origins using the aggregate collaboration identity', async () => {
  const links = vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue([]);
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(sharedConversationView())}
        names={names}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText(sharedReply.text)).toBeTruthy());
  fireEvent(document, new Event('visibilitychange'));
  expect(links).not.toHaveBeenCalled();
});
it('keeps the successful reply visible beside uncertain and pending independent recipients', () => {
  const projection = createCollaborationProjection(sharedConversationView());
  const { rerender } = render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} />
    </MemoryRouter>,
  );
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
  fireEvent.click(screen.getByText('To Architect, Reviewer · Context for Reader'));
  expect(screen.getByText('Prompt accepted')).toBeTruthy();
  expect(screen.getByText('Outcome uncertain · do not resend')).toBeTruthy();
  expect(screen.getByText('Context pending · no response requested')).toBeTruthy();
  const receipt = screen
    .getByText('To Architect, Reviewer · Context for Reader')
    .closest('details')!;
  const refused = applyCollaborationEvents(projection, {
    events: [],
    cursor: 99,
    highWatermark: 99,
    hasMore: false,
  });
  rerender(
    <MemoryRouter>
      <CollaborationTranscript projection={refused} names={names} />
    </MemoryRouter>,
  );
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
  expect(screen.getByText('To Architect, Reviewer · Context for Reader').closest('details')).toBe(
    receipt,
  );
  expect(receipt.open).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Refresh');
  expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull();
});
it('uses the actual source session and frozen prompt settings, without current account substitutions', () => {
  const view = sharedConversationView();
  const onRefresh = vi.fn();
  const projection = createCollaborationProjection(view);
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} onRefresh={onRefresh} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText('Message details for Architect'));
  expect(screen.getByText('Session architect')).toBeTruthy();
  expect(screen.getByText('same-offline-account · offline-fixture')).toBeTruthy();
  expect(onRefresh).not.toHaveBeenCalled();
});
it('projects replayed recipient failures without deleting another recipient reply', () => {
  const projection = applyCollaborationEvents(
    createCollaborationProjection(sharedConversationView()),
    {
      events: [
        {
          version: 1,
          collaborationId: uuid(1),
          eventId: uuid(30),
          sequence: 3,
          change: {
            kind: 'delivery',
            messageId: sharedPrompt.messageId,
            delivery: {
              ...sharedPrompt.deliveries[1],
              revision: 2,
              status: 'failed',
              reason: 'Definite refusal',
            },
          },
        },
      ],
      cursor: 3,
      highWatermark: 3,
      hasMore: false,
    },
  );
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByText('To Architect, Reviewer · Context for Reader · 1 recipient needs attention'),
  );
  expect(screen.getByText('Prompt failed')).toBeTruthy();
  expect(screen.getByText('Definite refusal')).toBeTruthy();
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
});

it('opens the existing Markdown preview through its author session API scope', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ path: 'plan.md', content: 'Retained source preview' }), {
      status: 200,
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const view = sharedConversationView();
  view.messages[1].text = '[Plan](/workspace/plan.md)';
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={createCollaborationProjection(view)} names={names} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /MD.*plan.md/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const url = new URL(fetch.mock.calls[0][0], 'http://offline.test');
  expect(url.pathname).toBe('/api/files/read');
  expect(url.searchParams.get('sessionId')).toBe('architect');
  expect(await screen.findByText('Retained source preview')).toBeTruthy();
});
