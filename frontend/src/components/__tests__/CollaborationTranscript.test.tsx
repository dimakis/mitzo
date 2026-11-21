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
import { ReplyQuote } from '../ReplyQuote';
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
it('integrates the replying agent name and stable color into its bubble with the recorded timestamp', () => {
  const view = sharedConversationView();
  view.messages = [{ ...sharedReply, recordedAt: 1794814800000 }];
  const { container } = render(
    <MemoryRouter>
      <CollaborationTranscript projection={createCollaborationProjection(view)} names={names} />
    </MemoryRouter>,
  );
  const bubble = screen.getByText(sharedReply.text).closest('.msg-bubble')!;
  expect(bubble.querySelector('.msg-bubble-speaker')?.textContent).toContain('Architect');
  expect(bubble.getAttribute('data-speaker-session')).toBe('architect');
  expect(container.querySelector('time')?.getAttribute('datetime')).toBe(
    new Date(1794814800000).toISOString(),
  );
});
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

it('keeps unmatched completed source rows in native sequence order around exact shared anchors', () => {
  const view = sharedConversationView();
  const rich: FinishedMessage = {
    messageId: 'final-answer',
    role: 'assistant',
    startedSeq: 10,
    blocks: [{ blockId: 'text', blockType: 'text', content: 'Anchored reply' }],
  };
  const later: FinishedMessage = {
    messageId: 'later-source',
    role: 'assistant',
    startedSeq: 30,
    blocks: [{ blockId: 'text', blockType: 'text', content: 'Later native work' }],
  };
  // Independent completion/reload arrival order is not chronology.
  const { container, rerender } = render(
    <MemoryRouter>
      <CollaborationTranscript
        names={names}
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([later, rich])}
      />
    </MemoryRouter>,
  );
  const order = () => container.querySelector('.chat-messages')!.textContent!;
  expect(order().indexOf('Anchored reply')).toBeLessThan(order().indexOf('Later native work'));
  rerender(
    <MemoryRouter>
      <CollaborationTranscript
        names={names}
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([rich, later])}
      />
    </MemoryRouter>,
  );
  expect(order().indexOf('Anchored reply')).toBeLessThan(order().indexOf('Later native work'));
});

it('retains an exact reply quote through streaming, rich completion and reload', () => {
  const view = sharedConversationView();
  view.messages = [sharedPrompt];
  const progress = {
    collaborationId: view.collaborationId,
    membershipRevision: view.membershipRevision,
    replies: [
      {
        projectionId: sharedReply.projectionId,
        sourceMessageId: 'final-answer',
        deliveryId: sharedReply.replyToDeliveryId!,
        sessionId: 'architect',
        text: 'Live reply',
      },
    ],
    refusals: [],
  };
  const tree = (ordinary?: ChatAreaProps) => (
    <MemoryRouter>
      <CollaborationTranscript
        names={names}
        projection={createCollaborationProjection(view)}
        progress={progress}
        ordinary={ordinary}
      />
    </MemoryRouter>
  );
  const mounted = render(tree());
  expect(screen.getByRole('button', { name: `Replying to: ${sharedPrompt.text}` })).toBeTruthy();
  view.messages.push(sharedReply);
  mounted.rerender(
    tree(
      sourceChat([
        {
          messageId: 'final-answer',
          replyToMessageId: 'ordinary-architect',
          role: 'assistant',
          blocks: [{ blockId: 'text', blockType: 'text', content: sharedReply.text }],
        },
      ]),
    ),
  );
  expect(screen.getByRole('button', { name: `Replying to: ${sharedPrompt.text}` })).toBeTruthy();
  expect(screen.queryByText('Original message unavailable')).toBeNull();
  mounted.rerender(tree());
  expect(screen.getByRole('button', { name: `Replying to: ${sharedPrompt.text}` })).toBeTruthy();
});

it('keeps a native stream before later native completion across reload', () => {
  const view = sharedConversationView();
  view.messages = [sharedPrompt];
  const stream = { ...sourceStream('ordinary-architect'), startedSeq: 10 };
  const later: FinishedMessage = {
    messageId: 'later-completion',
    replyToMessageId: 'ordinary-architect',
    startedSeq: 30,
    role: 'assistant',
    blocks: [{ blockId: 'later', blockType: 'text', content: 'Later completion' }],
  };
  const tree = (ordinary: ChatAreaProps) => (
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={ordinary}
        names={names}
      />
    </MemoryRouter>
  );
  const { container, rerender } = render(tree(sourceChat([later], stream)));
  const order = () => container.querySelector('.chat-messages')!.textContent!;
  expect(order().indexOf('Same visible body')).toBeLessThan(order().indexOf('Later completion'));
  rerender(
    tree(
      sourceChat([
        later,
        {
          messageId: stream.messageId,
          startedSeq: stream.startedSeq,
          replyToMessageId: stream.replyToMessageId,
          role: 'assistant',
          blocks: [{ blockId: 'text', blockType: 'text', content: 'Same visible body' }],
        },
      ]),
    ),
  );
  expect(order().indexOf('Same visible body')).toBeLessThan(order().indexOf('Later completion'));
});

it('names automated assignments and activity with readable summaries and retained technical detail', () => {
  const view = sharedConversationView();
  view.messages = [{ ...sharedPrompt, origin: { sessionId: 'reader', requestId: uuid(901) } }];
  const { container } = render(
    <MemoryRouter>
      <CollaborationTranscript
        names={names}
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([
          {
            messageId: 'tool',
            replyToMessageId: 'ordinary-architect',
            role: 'assistant',
            blocks: [
              {
                blockId: 't',
                blockType: 'tool_use',
                toolName: 'mcp__mitzo__TaskExecution',
                toolInput: '{"operation":"run","command":"npm test","grantId":"technical-grant"}',
                content: '',
              },
            ],
          },
        ])}
      />
    </MemoryRouter>,
  );
  expect(
    screen
      .getByText(sharedPrompt.text)
      .closest('.msg-bubble')
      ?.getAttribute('data-speaker-session'),
  ).toBe('reader');
  const activity = screen.getByRole('button', { name: /Architect.*Run command/ });
  expect(activity.textContent).not.toContain('technical-grant');
  expect(container.querySelector('.agent-activity')?.textContent).toContain('Architect');
  fireEvent.click(screen.getByRole('button', { name: /^mcp__mitzo__TaskExecution/ }));
  expect(screen.getAllByText(/technical-grant/).length).toBeGreaterThan(0);
});

it('keeps roster accents distinct and stable for removed authors after remount', () => {
  const view = sharedConversationView();
  view.seatOrder = Array.from({ length: 16 }, (_, index) => `seat-${index}`);
  view.participantSessionIds = [...view.seatOrder];
  view.messages = view.seatOrder.map((sessionId, index) => ({
    ...sharedReply,
    messageId: uuid(700 + index),
    projectionId: uuid(800 + index),
    sequence: index + 1,
    author: { sessionId },
    source: { ...sharedReply.source!, conversationId: sessionId },
  }));
  const tree = (key: number) => (
    <MemoryRouter>
      <CollaborationTranscript key={key} projection={createCollaborationProjection(view)} />
    </MemoryRouter>
  );
  const { container, rerender } = render(tree(0));
  const accents = () =>
    [...container.querySelectorAll<HTMLElement>('[data-speaker-session]')].map((node) =>
      node.style.getPropertyValue('--message-speaker-color'),
    );
  const before = accents();
  expect(new Set(before).size).toBe(16);
  view.participantSessionIds = view.participantSessionIds.slice(2);
  rerender(tree(1));
  expect(accents()).toEqual(before);
});
it('navigates a shared quote to the exact retained rich source through projection aliases', () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(sharedConversationView())}
        names={names}
        ordinary={sourceChat([
          {
            messageId: 'final-answer',
            role: 'assistant',
            blocks: [{ blockId: 'text', blockType: 'text', content: 'Exact rich source' }],
          },
        ])}
      />
      <ReplyQuote
        sessionId="architect"
        reply={{
          messageId: sharedReply.projectionId,
          role: 'assistant',
          text: 'Exact rich source',
        }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Replying to: Exact rich source' }));
  expect(document.activeElement?.getAttribute('data-reply-source')).toBe('final-answer');
});

it('keeps ordinary source aliases and actual quoted author after reloading projected rows', () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const view = sharedConversationView();
  view.messages.push({
    ...sharedPrompt,
    messageId: uuid(940),
    projectionId: uuid(941),
    sequence: 3,
    text: 'Follow up',
    inReplyTo: { messageId: 'final-answer', role: 'assistant', text: sharedReply.text },
  });
  render(
    <MemoryRouter>
      <CollaborationTranscript
        names={names}
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([])}
      />
    </MemoryRouter>,
  );
  const quote = screen.getByRole('button', { name: `Replying to: ${sharedReply.text}` });
  expect(quote.textContent).toContain('Architect');
  fireEvent.click(quote);
  expect(document.activeElement?.getAttribute('data-reply-source')).toBe(sharedReply.projectionId);
});

it('does not guess a reply target when one native packet carries several shared prompts', () => {
  const view = sharedConversationView();
  view.messages = [
    sharedPrompt,
    {
      ...sharedPrompt,
      messageId: uuid(950),
      projectionId: uuid(951),
      sequence: 2,
      text: 'Another exact body',
    },
  ];
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat([], sourceStream('ordinary-architect'))}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('button', { name: 'Replying to: Another exact body' })).toBeNull();
  expect(screen.getByText('Original message unavailable')).toBeTruthy();
});

it('does not duplicate a just-finished source while its old stream is still present', () => {
  const view = sharedConversationView();
  view.messages = [sharedPrompt];
  const stream = sourceStream('ordinary-architect');
  render(
    <MemoryRouter>
      <CollaborationTranscript
        projection={createCollaborationProjection(view)}
        ordinary={sourceChat(
          [
            {
              messageId: stream.messageId,
              role: 'assistant',
              replyToMessageId: stream.replyToMessageId,
              blocks: [{ blockId: 'text', blockType: 'text', content: 'Same visible body' }],
            },
          ],
          stream,
        )}
      />
    </MemoryRouter>,
  );
  expect(screen.getAllByText('Same visible body')).toHaveLength(1);
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

it('retains exact source packet suppression and operator bodies across the fifty-message window', () => {
  const view = sharedConversationView();
  view.messages = [sharedPrompt];
  view.cursor = sharedPrompt.sequence;
  let projection = createCollaborationProjection(view);
  const tree = () => (
    <MemoryRouter>
      <CollaborationTranscript
        projection={projection}
        ordinary={sourceChat([
          {
            messageId: 'ordinary-architect',
            role: 'user',
            blocks: [
              { blockId: 'packet', blockType: 'text', content: 'Encoded native delivery packet' },
            ],
          },
        ])}
      />
    </MemoryRouter>
  );
  const mounted = render(tree());
  for (let index = 0; index < 51; index++) {
    const sequence = projection.view.cursor + 1;
    projection = applyCollaborationEvents(projection, {
      events: [
        {
          version: 1,
          eventId: uuid(600 + index),
          collaborationId: view.collaborationId,
          sequence,
          change: {
            kind: 'message',
            message: {
              ...sharedPrompt,
              sequence,
              messageId: uuid(200 + index),
              projectionId: uuid(400 + index),
              text: 'Later operator ' + index,
              responders: [],
              readers: [],
              settings: {},
              deliveries: [],
            },
          },
        },
      ],
      cursor: sequence,
      highWatermark: sequence,
      hasMore: false,
    });
  }
  expect(projection.view.messages).toHaveLength(50);
  expect(projection.view.hasEarlierMessages).toBe(true);
  mounted.rerender(tree());
  expect(screen.queryByText('Encoded native delivery packet')).toBeNull();
  expect(screen.getAllByText(sharedPrompt.text)).toHaveLength(1);
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
