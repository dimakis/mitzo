// @vitest-environment jsdom
import { afterEach, expect, it, vi, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImageAttachment } from '../../types/chat';
import type { ComponentProps } from 'react';
import type { SendMessageOptions } from '@mitzo/client';
import { ChatInput } from '../ChatInput';
import { resizeImage } from '../../lib/resizeImage';
import { createChatDraft, saveChatDraft, getChatDraft } from '../../lib/chat-drafts';

const editor = vi.hoisted(() => ({
  current: null as null | {
    image: ImageAttachment;
    onSave(image: ImageAttachment): void;
    onClose(): void;
  },
}));
vi.mock('../ImageAttachmentEditor', () => ({
  ImageAttachmentEditor: (props: NonNullable<typeof editor.current>) => {
    editor.current = props;
    return (
      <div role="dialog" aria-label="Edit attachment">
        <span>{props.image.data}</span>
        <button
          onClick={() =>
            props.onSave({
              data: 'edited',
              mediaType: 'image/png',
              preview: 'data:image/png;base64,edited',
            })
          }
        >
          Save preview
        </button>
        <button onClick={props.onClose}>Cancel preview</button>
      </div>
    );
  },
}));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../ContextPanel', () => ({ ContextPanel: () => null }));
vi.mock('../../lib/resizeImage', () => ({
  resizeImage: vi.fn(async (file: File) => ({
    data: file.name,
    mediaType: 'image/png',
    preview: `data:image/png;base64,${file.name}`,
  })),
}));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  editor.current = null;
});
const props = {
  onSend: vi.fn<ComponentProps<typeof ChatInput>['onSend']>(() => true),
  onStop: vi.fn(),
  running: false,
  sessionId: 'preview-session',
};
async function attach(container: HTMLElement, names = ['one.png', 'two.png']) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: names.map((name) => new File(['pixels'], name, { type: 'image/png' })) },
  });
  await screen.findByAltText(`Attachment ${names.length}`);
}

it('previews and saves the selected composer image without changing text or another image', async () => {
  const onSend = vi.fn<ComponentProps<typeof ChatInput>['onSend']>(() => true);
  const { container } = render(<ChatInput {...props} onSend={onSend} externalContextBlocks={[]} />);
  await attach(container);
  fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Keep my words' } });
  const opener = screen.getByRole('button', { name: 'Preview attachment 2' });
  fireEvent.click(opener);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(editor.current?.image.data).toBe('two.png');
  fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Preview attachment 2' })).toBe(opener);
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('one.png');
  expect(screen.getByAltText('Attachment 2').getAttribute('src')).toContain('edited');
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Keep my words');
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(onSend.mock.calls[0][1]?.map((image: ImageAttachment) => image.data)).toEqual([
    'one.png',
    'edited',
  ]);
});

it('keeps cancel and removal separate from preview, with sibling buttons', async () => {
  const { container } = render(<ChatInput {...props} />);
  await attach(container);
  const preview = screen.getByRole('button', { name: 'Preview attachment 1' });
  const remove = screen.getByRole('button', { name: 'Remove attachment 1' });
  expect(preview.contains(remove)).toBe(false);
  fireEvent.click(preview);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }));
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('one.png');
  fireEvent.click(remove);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('two.png');
});

it('edits a Sources image through the same editor', async () => {
  const { container } = render(<ChatInput {...props} />);
  await attach(container);
  fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Sources' }));
  const opener = screen.getByRole('button', { name: 'Preview pasted image 2' });
  fireEvent.click(opener);
  expect(editor.current?.image.data).toBe('two.png');
  fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
  expect(screen.getByRole('button', { name: 'Preview pasted image 2' })).toBe(opener);
  expect(screen.getByAltText('Attachment 2').getAttribute('src')).toContain('edited');
});

it('retains selected object identity when an earlier attachment is removed', async () => {
  const { container } = render(<ChatInput {...props} />);
  await attach(container);
  fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('edited');
  expect(screen.queryByAltText('Attachment 2')).toBeNull();
});

it('ignores stale editor saves after the selected attachment is removed', async () => {
  const { container } = render(<ChatInput {...props} />);
  await attach(container);
  fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
  const staleSave = editor.current!.onSave;
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  staleSave({ data: 'stale', mediaType: 'image/png', preview: 'data:image/png;base64,stale' });
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('two.png');
});

it.each(['session', 'generation', 'storage'] as const)(
  'closes the editor on %s change and ignores its stale save',
  async (change) => {
    const { container, rerender } = render(
      <ChatInput {...props} composerGeneration={0} draftStorageKey="old-draft" />,
    );
    await attach(container);
    fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
    const staleSave = editor.current!.onSave;
    rerender(
      <ChatInput
        {...props}
        sessionId={change === 'session' ? 'new-session' : props.sessionId}
        composerGeneration={change === 'generation' ? 1 : 0}
        draftStorageKey={change === 'storage' ? 'new-draft' : 'old-draft'}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    staleSave({ data: 'stale', mediaType: 'image/png', preview: 'data:image/png;base64,stale' });
    expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('one.png');
  },
);

it.each(['Cancel preview', 'Save preview'])(
  'defers queued drain until %s closes the editor without sending the current draft',
  async (close) => {
    const onSend = vi.fn<ComponentProps<typeof ChatInput>['onSend']>(() => true);
    const onInterrupt = vi.fn();
    const { container, rerender } = render(
      <ChatInput {...props} running onSend={onSend} onInterrupt={onInterrupt} />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    await attach(container, ['one.png']);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Current draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(onInterrupt).not.toHaveBeenCalled();
    rerender(<ChatInput {...props} running={false} onSend={onSend} onInterrupt={onInterrupt} />);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: close }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      'Queued',
      undefined,
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Current draft');
    expect(screen.getByText('Queued')).toBeTruthy();
  },
);

it.each(['accepted', 'failed'] as const)(
  'preserves edited image draft through a late %s interrupt receipt',
  async (status) => {
    let receipt: SendMessageOptions['onDelivery'];
    const onInterrupt = vi.fn<NonNullable<ComponentProps<typeof ChatInput>['onInterrupt']>>(
      (_text, _images, _context, onDelivery) => {
        receipt = onDelivery;
      },
    );
    const { container } = render(<ChatInput {...props} running onInterrupt={onInterrupt} />);
    await attach(container, ['one.png']);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Exact request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt and send now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
    act(() => receipt?.(status));
    expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('edited');
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Exact request');
    expect(onInterrupt.mock.calls[0][1]?.[0].data).toBe('one.png');
    if (status === 'failed') {
      expect(JSON.parse(localStorage.getItem('mitzo-queue-preview-session')!)[0]).toMatchObject({
        text: 'Exact request',
        requiresRetry: true,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('one.png');
    }
  },
);

it.each(['session', 'generation', 'storage'] as const)(
  'does not release a deferred completion after %s ownership changes',
  async (change) => {
    const onSend = vi.fn<ComponentProps<typeof ChatInput>['onSend']>(() => true);
    const oldProps = { ...props, onSend, composerGeneration: 0, draftStorageKey: 'old-draft' };
    const { container, rerender } = render(<ChatInput {...oldProps} running />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Old queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    await attach(container, ['one.png']);
    fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
    rerender(<ChatInput {...oldProps} running={false} />);
    expect(onSend).not.toHaveBeenCalled();
    localStorage.setItem(
      'mitzo-queue-destination',
      JSON.stringify([{ text: 'Destination pending', contextBlocks: [] }]),
    );
    const destinationProps = {
      ...oldProps,
      sessionId: change === 'session' ? 'destination' : props.sessionId,
      composerGeneration: change === 'generation' ? 1 : 0,
      draftStorageKey: change === 'storage' ? 'new-draft' : 'old-draft',
    };
    rerender(<ChatInput {...destinationProps} running={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    const pending = change === 'session' ? 'Destination pending' : 'Old queued';
    expect(screen.getByText(pending)).toBeTruthy();
    // A real completion in the destination scope can still drain its own queue.
    rerender(<ChatInput {...destinationProps} running />);
    rerender(<ChatInput {...destinationProps} running={false} />);
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      pending,
      undefined,
      undefined,
      expect.any(Function),
      expect.any(Function),
    );
  },
);
it('restores saved images and persists an edited image with the same draft settings', () => {
  const draft = {
    ...createChatDraft(),
    text: 'Saved image request',
    contextBlocks: ['Saved context'],
    images: [
      { data: 'original', mediaType: 'image/png', preview: 'data:image/png;base64,original' },
    ],
  };
  draft.settings.selection = { accountId: 'work', model: 'luna', reasoningEffort: 'high' };
  saveChatDraft(draft);
  const view = render(<ChatInput {...props} sessionId={undefined} savedChatDraft={draft} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
  view.unmount();
  expect(getChatDraft(draft.id)).toMatchObject({
    text: draft.text,
    contextBlocks: draft.contextBlocks,
    settings: draft.settings,
    images: [{ data: 'edited', mediaType: 'image/png' }],
  });
  render(<ChatInput {...props} sessionId={undefined} savedChatDraft={getChatDraft(draft.id)!} />);
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('edited');
});
it('closes a saved draft image preview on A-to-B navigation and ignores the stale editor callback', () => {
  const first = {
    ...createChatDraft(),
    text: 'First',
    images: [{ data: 'first', mediaType: 'image/png', preview: 'data:image/png;base64,first' }],
  };
  const second = {
    ...createChatDraft(),
    text: 'Second',
    images: [{ data: 'second', mediaType: 'image/png', preview: 'data:image/png;base64,second' }],
  };
  saveChatDraft(first);
  saveChatDraft(second);
  const view = render(<ChatInput {...props} sessionId={undefined} savedChatDraft={first} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
  const staleSave = editor.current!.onSave;
  view.rerender(<ChatInput {...props} sessionId={undefined} savedChatDraft={second} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() =>
    staleSave({ data: 'stale', mediaType: 'image/png', preview: 'data:image/png;base64,stale' }),
  );
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('second');
  expect(getChatDraft(first.id)?.images[0].data).toBe('first');
  expect(getChatDraft(second.id)?.images[0].data).toBe('second');
});
it('keeps a saved draft image edit after acceptance of the older submitted image revision', () => {
  const draft = {
    ...createChatDraft(),
    text: 'Image request',
    images: [
      { data: 'original', mediaType: 'image/png', preview: 'data:image/png;base64,original' },
    ],
  };
  saveChatDraft(draft);
  let receipt: SendMessageOptions['onDelivery'];
  const onSend = vi.fn<ComponentProps<typeof ChatInput>['onSend']>(
    (_text, _images, _context, onDelivery) => {
      receipt = onDelivery;
      return true;
    },
  );
  render(<ChatInput {...props} sessionId={undefined} onSend={onSend} savedChatDraft={draft} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview attachment 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save preview' }));
  act(() => receipt?.('accepted'));
  expect(onSend.mock.calls[0][1]?.[0].data).toBe('original');
  expect(getChatDraft(draft.id)?.images[0].data).toBe('edited');
  expect(screen.getByAltText('Attachment 1').getAttribute('src')).toContain('edited');
  // The image edit is new work; the unchanged text already has its exact receipt.
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  expect(getChatDraft(draft.id)?.text).toBe('');
});

for (const input of ['file', 'paste'] as const) {
  it.each(['new', 'draft', 'unmount'] as const)(
    `ignores pending ${input} image results after %s ownership ends`,
    async (change) => {
      const first = { ...createChatDraft(), text: 'First draft' };
      const second = { ...createChatDraft(), text: 'Second draft' };
      saveChatDraft(first);
      saveChatDraft(second);
      let finishResize!: (image: ImageAttachment) => void;
      const resize = vi.mocked(resizeImage);
      const callsBefore = resize.mock.calls.length;
      resize.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishResize = resolve;
          }),
      );
      const view = render(
        <ChatInput
          {...props}
          sessionId={undefined}
          savedChatDraft={first}
          composerGeneration={0}
        />,
      );
      const files = ['old.png', 'not-started.png'].map(
        (name) => new File(['pixels'], name, { type: 'image/png' }),
      );
      if (input === 'file')
        fireEvent.change(view.container.querySelector('input[type="file"]')!, {
          target: { files },
        });
      else
        fireEvent.paste(screen.getByLabelText('Message Mitzo'), {
          clipboardData: {
            items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
          },
        });
      expect(resize.mock.calls.length - callsBefore).toBe(1);
      if (change === 'unmount') view.unmount();
      else
        view.rerender(
          <ChatInput
            {...props}
            sessionId={undefined}
            savedChatDraft={change === 'draft' ? second : createChatDraft()}
            composerGeneration={change === 'new' ? 1 : 0}
          />,
        );
      await act(async () =>
        finishResize({
          data: 'old-image',
          mediaType: 'image/png',
          preview: 'data:image/png;base64,old-image',
        }),
      );
      expect(resize.mock.calls.length - callsBefore).toBe(1);
      expect(getChatDraft(first.id)?.images).toEqual([]);
      expect(getChatDraft(second.id)?.images).toEqual([]);
      if (change !== 'unmount') expect(screen.queryByAltText('Attachment 1')).toBeNull();
    },
  );
}
