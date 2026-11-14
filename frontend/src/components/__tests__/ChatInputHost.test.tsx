// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../ChatInput';
import { ChatInputHost, RetainedChatInputSlot } from '../ChatInputHost';
import { ComposerStatusProvider, ComposerStatusRail } from '../ComposerStatus';
import { createChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import { SharedConversationComposerContext } from '../../lib/shared-conversation-composer';
import { installDialogStub } from './dialog-stub';
import { chatStorage } from '../../lib/large-chat-storage';
import { queuedButton } from '../../test-utils/queued-draft-controls';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it('reports retained recovery controls to the current page status owner during qualification', async () => {
  installDialogStub();
  const recover = vi.fn();
  function Phone() {
    return (
      <ComposerStatusProvider>
        <ChatInput sessionId="source" running={false} onSend={() => false} onStop={() => {}} />
      </ComposerStatusProvider>
    );
  }
  function Desktop() {
    return (
      <ComposerStatusProvider>
        <RetainedChatInputSlot sessionId="source">
          <p>Checking</p>
        </RetainedChatInputSlot>
      </ComposerStatusProvider>
    );
  }
  const tree = (desktop = false) => (
    <MemoryRouter>
      <ChatInputHost sessionId="source">
        <SharedConversationComposerContext.Provider
          value={{
            sourceConversationId: 'source',
            props: {
              sendDisabledReason: 'Original request remains uncertain',
              sendDisabledAction: { label: 'Check original request', onClick: recover },
            },
          }}
        >
          {desktop ? <Desktop /> : <Phone />}
        </SharedConversationComposerContext.Provider>
      </ChatInputHost>
    </MemoryRouter>
  );
  const { rerender } = render(tree());
  await screen.findByRole('button', { name: 'Check original request' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
  const details = await screen.findByRole('dialog', { name: 'Conversation status' });
  fireEvent.keyDown(details, { key: 'Escape' });
  const input = screen.getByRole('textbox');
  rerender(tree(true));
  expect(screen.getByRole('textbox')).toBe(input);
  fireEvent.click(await screen.findByRole('button', { name: 'Check original request' }));
  expect(recover).toHaveBeenCalledOnce();
});

it('moves the same ordinary input between responsive owners with unsaved rich edits and focus intact', async () => {
  const draft = {
    ...createChatDraft(),
    text: 'Original saved draft',
    contextBlocks: ['Saved context'],
    images: [{ data: 'YQ==', preview: 'data:image/png;base64,YQ==', mediaType: 'image/png' }],
  };
  saveChatDraft(draft);
  const send = vi.fn<import('react').ComponentProps<typeof ChatInput>['onSend']>(() => false);
  const props = {
    sessionId: 'source',
    savedChatDraft: draft,
    onSend: send,
    onStop: vi.fn(),
    running: false,
  };
  function Phone() {
    return (
      <main>
        <ChatInput {...props} />
      </main>
    );
  }
  function Desktop() {
    return (
      <section>
        <ChatInput {...props} />
      </section>
    );
  }
  const single = (desktop = false) => (
    <MemoryRouter>
      <ChatInputHost sessionId="source">
        <ComposerStatusProvider>
          <ComposerStatusRail />
          {desktop ? <Desktop /> : <Phone />}
        </ComposerStatusProvider>
      </ChatInputHost>
    </MemoryRouter>
  );
  const { container, rerender } = render(single());
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Unsaved edit during layout change' } });
  input.focus();
  input.setSelectionRange(3, 9);
  expect(container.querySelectorAll('.chat-input-field')).toHaveLength(1);
  const images = container.querySelectorAll('img');
  expect(images.length).toBeGreaterThan(0);
  rerender(single(true));
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input.value).toBe('Unsaved edit during layout change');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([3, 9]);
  expect(container.querySelectorAll('img')).toHaveLength(images.length);
  expect(send).not.toHaveBeenCalled();
  rerender(single());
  expect(screen.getByRole('textbox')).toBe(input);
  expect(container.querySelectorAll('.chat-input-field')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0]).toBe('Unsaved edit during layout change');
  expect(send.mock.calls[0][1]).toEqual(draft.images);
  expect(send.mock.calls[0][2]).toEqual(['Saved context']);
});

it('leaves an unrelated embedded input with its own session owner', () => {
  render(
    <MemoryRouter>
      <ChatInputHost sessionId="source">
        <ChatInput
          sessionId="source"
          initialText="Source draft"
          running={false}
          onSend={() => false}
          onStop={() => {}}
        />
        <ChatInput
          sessionId="other"
          initialText="Other draft"
          running={false}
          onSend={() => false}
          onStop={() => {}}
        />
      </ChatInputHost>
    </MemoryRouter>,
  );
  expect(
    screen.getAllByRole('textbox').map((input) => (input as HTMLTextAreaElement).value),
  ).toEqual(['Source draft', 'Other draft']);
});

it('cannot expose another conversation draft while the next page is qualifying', () => {
  const tree = (sessionId: string, pending = false) => (
    <MemoryRouter>
      <ChatInputHost sessionId={sessionId}>
        {pending ? (
          <RetainedChatInputSlot sessionId={sessionId}>
            <p>Checking new conversation</p>
          </RetainedChatInputSlot>
        ) : (
          <ChatInput
            sessionId={sessionId}
            initialText="Private source draft"
            running={false}
            onSend={() => false}
            onStop={() => {}}
          />
        )}
      </ChatInputHost>
    </MemoryRouter>
  );
  const { rerender } = render(tree('source'));
  expect(screen.getByRole('textbox')).toBeTruthy();
  rerender(tree('different-conversation', true));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText('Checking new conversation')).toBeTruthy();
});

it.each(['send', 'steer'] as const)(
  'retires an old %s awaiting durable preparation when navigating to a qualifying conversation',
  async (kind) => {
    localStorage.setItem(
      'mitzo-queue-source',
      JSON.stringify([
        {
          text: 'Old queued prompt',
          contextBlocks: [],
          queueEntryId: 'old-queued-command',
          ...(kind === 'steer'
            ? {
                requiresRetry: true,
                dispatchPending: true,
                dispatchKind: 'steer',
                steeringTargetCommandId: 'original-turn',
              }
            : {}),
        },
      ]),
    );
    let release!: () => void;
    const flush = vi.spyOn(chatStorage, 'flush').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const send = vi.fn(() => true);
    const steer = vi.fn();
    const tree = (sessionId = 'source', running = true) => (
      <MemoryRouter>
        <ChatInputHost sessionId={sessionId}>
          {sessionId === 'source' ? (
            <ChatInput
              sessionId={sessionId}
              guardedConversation
              running={running}
              onSend={send}
              onInterrupt={steer}
              interruptLabel="Steer current turn"
              onStop={() => {}}
            />
          ) : (
            <RetainedChatInputSlot sessionId={sessionId}>
              <p>Checking next conversation</p>
            </RetainedChatInputSlot>
          )}
        </ChatInputHost>
      </MemoryRouter>
    );
    const { rerender } = render(tree());
    if (kind === 'steer') fireEvent.click(queuedButton('Check delivery of queued prompt 1'));
    else rerender(tree('source', false));
    await waitFor(() => expect(flush).toHaveBeenCalledOnce());
    rerender(tree('next'));
    await act(async () => release());
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(localStorage.getItem('mitzo-queue-source')).toContain('Old queued prompt');
  },
);
