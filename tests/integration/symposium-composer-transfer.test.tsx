// @vitest-environment jsdom
import React, { type ComponentProps } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useStore } from 'zustand';
import { createMitzoStore } from '@mitzo/client';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatInputHost } from '../../frontend/src/components/ChatInputHost';
import { chatStorage } from '../../frontend/src/lib/large-chat-storage';
import { queueDraft, queuedText } from '../../frontend/src/test-utils/queued-draft-controls';

// Client/portal integration, independently of the authenticated application
// journey. Only wire transport is deterministic; parser, exact receipt/assignment
// observers, draft/queue hooks and actual mounted input owner remain production.
beforeAll(async () => {
  console.info(
    'ORDINARY_TRANSFER_SOURCE',
    JSON.stringify({
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      branch:
        execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() ||
        'detached HEAD',
      testSha256: createHash('sha256')
        .update(await readFile(new URL(import.meta.url)))
        .digest('hex'),
      node: process.version,
      build: 'Vitest source transpilation',
      boundary:
        'Actual client/protocol/ChatInputHost/ChatInput; deterministic wire. No authenticated application or browser geometry qualification.',
    }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function fixture(initial: string | null) {
  let socket!: {
    readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    send(data: string): void;
    close(): void;
  };
  const sent: Record<string, unknown>[] = [];
  const store = createMitzoStore({
    transport: { fetch: async () => new Response('[]', { status: 200 }) },
    wsConfig: {
      buildUrl: () => 'ws://deterministic.invalid/ws',
      createWebSocket: () => {
        socket = {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: (data) => sent.push(JSON.parse(data)),
          close() {
            this.readyState = 3;
          },
        };
        return socket;
      },
    },
  });
  const receive = (message: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(message) }));
  socket.readyState = 1;
  socket.onopen?.({});
  receive({ type: 'welcome', protocolVersion: 2, connectionId: 'transfer-fixture' });
  if (initial) await store.getState().switchSession(initial);
  const onSend: ComponentProps<typeof ChatInput>['onSend'] = (
    text,
    images,
    contextBlocks,
    onDelivery,
    onSessionAssigned,
    composerDraft,
    replyTo,
    queuedCommandId,
  ) => {
    store.getState().sendMessage(text, {
      images,
      contextBlocks,
      onDelivery,
      onSessionAssigned,
      composerDraft,
      replyTo,
      clientMsgId: queuedCommandId,
    });
    return true;
  };
  function Scope() {
    const sessionId = useStore(store, (state) => state.sessions.active) ?? undefined;
    const running = useStore(store, (state) => state.messages.running);
    return (
      <ChatInputHost sessionId={sessionId}>
        <ChatInput sessionId={sessionId} running={running} onSend={onSend} onStop={() => {}} />
      </ChatInputHost>
    );
  }
  const ui = render(
    <MemoryRouter>
      <Scope />
    </MemoryRouter>,
  );
  const input = () => screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  const compose = (text: string) => fireEvent.change(input(), { target: { value: text } });
  return {
    ui,
    store,
    sent,
    receive,
    input,
    compose,
    // Controlled lifecycle edge only; command assignment/acceptance below goes
    // through the actual protocol parser and its retained correlation observers.
    running: (running: boolean) =>
      act(() =>
        store.setState((state) => ({
          messages: { ...state.messages, running },
        })),
      ),
    commands: () => sent.filter((message) => message.type === 'send'),
    close: () => {
      ui.unmount();
      store.getState().invalidateAuthentication();
    },
  };
}

it.each([
  { source: null, event: '_send_accepted', acceptedFirst: false },
  { source: 'original-chat', event: '_send_accepted', acceptedFirst: false },
  { source: null, event: 'session_id', acceptedFirst: false },
  { source: 'original-chat', event: 'session_id', acceptedFirst: true },
])(
  'transfers draft/queue through $event from $source (correlated acceptance first: $acceptedFirst)',
  async ({ source, event, acceptedFirst }) => {
    const f = await fixture(source);
    try {
      f.running(true);
      f.compose('Submitted queued command');
      await queueDraft();
      f.compose('Remaining queued work');
      await queueDraft();
      f.compose('Later edit before authenticated assignment');
      f.running(false);
      await waitFor(() => expect(f.commands()).toHaveLength(1));
      const command = f.commands()[0];
      const originalInput = f.input();
      expect(originalInput.value).toBe('Later edit before authenticated assignment');
      expect(queuedText('Remaining queued work')).toBeTruthy();
      originalInput.focus();
      originalInput.setSelectionRange(2, 9);
      // An existing ordinary fork is selected by its original-session receipt.
      // A bare foreign session_id is filtered by the real client; the subsequent
      // matching legacy frame must not recreate that already transferred owner.
      if (acceptedFirst)
        f.receive({
          type: '_send_accepted',
          originalSessionId: source,
          sessionId: 'assigned-chat',
          clientMsgId: command.clientMsgId,
        });
      f.receive({
        type: event,
        originalSessionId: source,
        sessionId: 'assigned-chat',
        clientMsgId: command.clientMsgId,
      });
      await waitFor(() => expect(f.store.getState().sessions.active).toBe('assigned-chat'));
      if (event === 'session_id')
        f.receive({
          type: 'user_message',
          sessionId: 'assigned-chat',
          messageId: command.clientMsgId,
          text: 'Submitted queued command',
        });
      expect.soft(f.input()).toBe(originalInput);
      expect.soft(f.input().value).toBe('Later edit before authenticated assignment');
      expect.soft(document.activeElement).toBe(originalInput);
      expect.soft([f.input().selectionStart, f.input().selectionEnd]).toEqual([2, 9]);
      expect.soft(queuedText('Remaining queued work')).toBeTruthy();
      fireEvent(window, new Event('pagehide'));
      expect
        .soft(chatStorage.getItem('mitzo-draft-assigned-chat'))
        .toBe('Later edit before authenticated assignment');
      expect
        .soft(JSON.parse(chatStorage.getItem('mitzo-queue-assigned-chat') ?? '[]'))
        .toMatchObject([{ text: 'Remaining queued work', contextBlocks: [] }]);
      expect(f.commands()).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

it('retires an unrelated navigation owner and does not promote late assignment into its draft', async () => {
  const f = await fixture('original-chat');
  try {
    f.compose('Original pending send');
    fireEvent.keyDown(f.input(), { key: 'Enter' });
    await waitFor(() => expect(f.commands()).toHaveLength(1));
    const command = f.commands()[0];
    f.compose('Original follow-up edit');
    const oldInput = f.input();
    await act(async () => f.store.getState().switchSession('unrelated-chat'));
    expect(f.input()).not.toBe(oldInput);
    f.compose('Independent unrelated draft');
    f.receive({
      type: '_send_accepted',
      originalSessionId: 'original-chat',
      sessionId: 'late-fork',
      clientMsgId: command.clientMsgId,
    });
    expect(f.store.getState().sessions.active).toBe('unrelated-chat');
    expect(f.input().value).toBe('Independent unrelated draft');
    fireEvent(window, new Event('pagehide'));
    expect(chatStorage.getItem('mitzo-draft-unrelated-chat')).toBe('Independent unrelated draft');
    expect(f.commands()).toHaveLength(1);
    await act(async () => f.store.getState().switchSession('original-chat'));
    expect(f.input().value).toBe('Original follow-up edit');
    expect(f.commands()).toHaveLength(1);
  } finally {
    f.close();
  }
});
