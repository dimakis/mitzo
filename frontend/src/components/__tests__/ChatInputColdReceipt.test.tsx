// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { SendMessageOptions } from '@mitzo/client';
import { ChatInput } from '../ChatInput';
import {
  createChatDraft,
  saveChatDraft,
  getChatDraft,
  chatDraftStorageKey,
} from '../../lib/chat-drafts';
import { acceptedComposerDraftKey } from '../../lib/composer-draft-proof';
import { useDraft } from '../../hooks/useDraft';
import { useNewChatDraft } from '../../hooks/useNewChatDraft';
import { createRef } from 'react';
import type { ChatInputDraftControl } from '../ChatInput';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../MicButton', () => ({ MicButton: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it.each(['ordinary', 'rich'] as const)(
  'notifies the same-owner replacement when an unmounted %s callback accepts late',
  (kind) => {
    const draft = {
      ...createChatDraft(),
      text: 'Submitted before replacement',
      images: [
        { data: 'image', preview: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
      ],
    };
    if (kind === 'rich') saveChatDraft(draft);
    let receipt: SendMessageOptions['onDelivery'];
    let proof: SendMessageOptions['composerDraft'];
    const props = {
      sessionId: 'chat',
      savedChatDraft: kind === 'rich' ? draft : undefined,
      onStop: () => {},
      running: false,
      onSend: () => false,
    };
    const first = render(
      <ChatInput
        {...props}
        onSend={(_text, _images, _context, callback, _assigned, submittedProof) => {
          receipt = callback;
          proof = submittedProof;
          return true;
        }}
      />,
    );
    if (kind === 'ordinary')
      fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: draft.text } });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(proof).toBeDefined();
    first.unmount();
    render(<ChatInput {...props} />);
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    if (kind === 'rich') expect(getChatDraft(draft.id)).toBeNull();
    else expect(localStorage.getItem('mitzo-draft-chat')).toBeNull();
  },
);

it.each([
  ['ordinary', 'context'],
  ['rich', 'context'],
  ['rich', 'attachment'],
] as const)(
  'does not regain an older %s receipt after a foreign same-text edit and local %s edit',
  (kind, edit) => {
    const draft = {
      ...createChatDraft(),
      text: 'Submitted exactly once',
      images:
        edit === 'attachment'
          ? [{ data: 'original', mediaType: 'image/png', preview: 'data:image/png;base64,b2xk' }]
          : [],
    };
    if (kind === 'rich') saveChatDraft(draft);
    let receipt: SendMessageOptions['onDelivery'];
    const props = {
      sessionId: 'chat',
      savedChatDraft: kind === 'rich' ? draft : undefined,
      onStop: () => {},
      running: false,
      onSend: (
        _text: string,
        _images: unknown,
        _context: unknown,
        callback: SendMessageOptions['onDelivery'],
      ) => {
        receipt = callback;
        return true;
      },
    };
    const first = render(<ChatInput {...props} />);
    if (kind === 'ordinary')
      fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: draft.text } });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    const other = renderHook(() =>
      useDraft('chat', undefined, kind === 'rich' ? chatDraftStorageKey(draft.id) : undefined),
    );
    act(() => {
      other.result.current[1]('Foreign intermediate text');
      other.result.current[1](draft.text);
      other.result.current[3]();
    });
    other.unmount();
    if (edit === 'attachment')
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
    else first.rerender(<ChatInput {...props} externalContextBlocks={['New local context']} />);
    act(() => receipt?.('accepted'));
    if (kind === 'rich') expect(getChatDraft(draft.id)?.text).toBe(draft.text);
    else expect(localStorage.getItem('mitzo-draft-chat')).toBe(draft.text);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', draft.text);
  },
);

it('fences rich layout, imperative flush and parent settings saves until failed revocation recovers', () => {
  const draft = {
    ...createChatDraft(),
    text: 'Original admitted text',
    images: [{ data: 'old', preview: 'data:image/png;base64,b2xk', mediaType: 'image/png' }],
  };
  saveChatDraft(draft);
  const control = createRef<ChatInputDraftControl>();
  let receipt: SendMessageOptions['onDelivery'];
  const props = {
    savedChatDraft: draft,
    draftControl: control,
    onStop: () => {},
    running: false,
    onSend: (
      _text: string,
      _images: unknown,
      _context: unknown,
      callback: SendMessageOptions['onDelivery'],
    ) => {
      receipt = callback;
      return true;
    },
  };
  render(<ChatInput {...props} />);
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  const write = Storage.prototype.setItem,
    remove = Storage.prototype.removeItem;
  const revisionKey = 'mitzo-draft-revision:' + encodeURIComponent(chatDraftStorageKey(draft.id));
  const writeFault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key === revisionKey) throw Error('Revision unavailable');
    write.call(this, key, value);
  });
  const removeFault = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key === revisionKey) throw Error('Revision unavailable');
    remove.call(this, key);
  });
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Newer unsaved text' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Remove attachment 1' }));
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
  expect(getChatDraft(draft.id)?.images).toEqual(draft.images);
  expect(control.current?.flush?.()).toBe(false);
  const parent = renderHook(() => useNewChatDraft(draft.id, 0, true));
  act(() => parent.result.current.saveSettings({ ...draft.settings, mode: 'ask' }));
  expect(parent.result.current.settingsError).toBe(true);
  expect(getChatDraft(draft.id)?.settings.mode).toBe('agent');
  act(() => receipt?.('accepted'));
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
  writeFault.mockRestore();
  removeFault.mockRestore();
  act(() => expect(control.current?.flush?.()).toBe(true));
  expect(getChatDraft(draft.id)?.text).toBe('Newer unsaved text');
  expect(getChatDraft(draft.id)?.images).toEqual([]);
});

it.each([
  ['ordinary', false],
  ['ordinary', true],
  ['rich', false],
  ['rich', true],
] as const)(
  'protects a newer %s revision from a mounted earlier receipt (same text=%s)',
  (kind, sameText) => {
    const draft = { ...createChatDraft(), text: 'Submitted exactly once' };
    if (kind === 'rich') saveChatDraft(draft);
    let receipt: SendMessageOptions['onDelivery'];
    const first = render(
      <ChatInput
        sessionId="chat"
        savedChatDraft={kind === 'rich' ? draft : undefined}
        onSend={(_text, _images, _context, callback) => {
          receipt = callback;
          return true;
        }}
        onStop={() => {}}
        running={false}
      />,
    );
    if (kind === 'ordinary')
      fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: draft.text } });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    const other = renderHook(() =>
      useDraft('chat', undefined, kind === 'rich' ? chatDraftStorageKey(draft.id) : undefined),
    );
    act(() => {
      other.result.current[1]('Independent other editor');
      if (sameText) other.result.current[1](draft.text);
      other.result.current[3]();
    });
    other.unmount();
    act(() => receipt?.('accepted'));
    const expected = sameText ? draft.text : 'Independent other editor';
    if (kind === 'rich') expect(getChatDraft(draft.id)?.text).toBe(expected);
    else expect(localStorage.getItem('mitzo-draft-chat')).toBe(expected);
    first.unmount();
  },
);

function submit() {
  const onSend = vi.fn(() => true);
  const view = render(
    <ChatInput sessionId="chat" onSend={onSend} onStop={() => {}} running={false} />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Submitted exactly once' },
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
  const proof = (onSend.mock.calls[0] as unknown[])[5] as SendMessageOptions['composerDraft'];
  return { view, proof };
}

it.each([false, true])(
  'consumes the exact reloaded draft with receipt already present: %s',
  (early) => {
    const { view, proof } = submit();
    expect(proof).toMatchObject({ storageKey: 'mitzo-draft-chat' });
    view.unmount();
    const props = { sessionId: 'chat', onSend: () => false, onStop: () => {}, running: false };
    const restored = render(
      <ChatInput {...props} acceptedComposerDraft={early ? proof : undefined} />,
    );
    if (!early) {
      expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
        'value',
        'Submitted exactly once',
      );
      restored.rerender(<ChatInput {...props} acceptedComposerDraft={proof} />);
    }
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(localStorage.getItem('mitzo-draft-chat')).toBeNull();
  },
);

it.each(['before-reload', 'after-reload'] as const)(
  'preserves a same-valued newer draft edited %s',
  (when) => {
    const { view, proof } = submit();
    expect(proof?.revisionToken).toBeTruthy();
    const edit = () => {
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Independent edit' },
      });
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Submitted exactly once' },
      });
    };
    if (when === 'before-reload') edit();
    view.unmount();
    const props = { sessionId: 'chat', onSend: () => false, onStop: () => {}, running: false };
    const restored = render(<ChatInput {...props} />);
    if (when === 'after-reload') edit();
    restored.rerender(<ChatInput {...props} acceptedComposerDraft={proof} />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      'Submitted exactly once',
    );
  },
);

it('preserves another composer owner and unproven legacy text', () => {
  const { view, proof } = submit();
  expect(proof?.revisionToken).toBeTruthy();
  view.unmount();
  localStorage.setItem('mitzo-draft-other-chat', 'Submitted exactly once');
  const restored = render(
    <ChatInput
      sessionId="other-chat"
      onSend={() => false}
      onStop={() => {}}
      running={false}
      acceptedComposerDraft={proof}
    />,
  );
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Submitted exactly once');
  restored.unmount();
  render(<ChatInput sessionId="chat" onSend={() => false} onStop={() => {}} running={false} />);
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Submitted exactly once');
});

it.each([false, true])(
  'consumes accepted rich attachments and context on cold owner restoration: %s',
  (switchOwner) => {
    const draft = {
      ...createChatDraft(),
      text: 'Accepted rich draft',
      images: [{ data: 'YWJj', preview: 'data:image/png;base64,YWJj', mediaType: 'image/png' }],
      contextBlocks: ['Accepted context'],
    };
    saveChatDraft(draft);
    const onSend = vi.fn(() => true);
    const first = render(
      <ChatInput savedChatDraft={draft} onSend={onSend} onStop={() => {}} running={false} />,
    );
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    const proof = (onSend.mock.calls[0] as unknown[])[5] as NonNullable<
      SendMessageOptions['composerDraft']
    >;
    expect(proof.storageKey).toBe(chatDraftStorageKey(draft.id));
    first.unmount();
    localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
    const props = { onSend: () => false, onStop: () => {}, running: false };
    const restored = render(
      <ChatInput
        {...props}
        savedChatDraft={switchOwner ? createChatDraft() : getChatDraft(draft.id)!}
      />,
    );
    if (switchOwner)
      restored.rerender(<ChatInput {...props} savedChatDraft={getChatDraft(draft.id)!} />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(screen.queryByAltText('Attachment 1')).toBeNull();
    expect(getChatDraft(draft.id)).toBeNull();
  },
);

it.each(['text', 'revision', 'all'] as const)(
  'clears an unchanged mounted ordinary composer after acceptance with unavailable %s storage',
  (failure) => {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (
        failure === 'all' ||
        (failure === 'text' ? key === 'mitzo-draft-chat' : key.startsWith('mitzo-draft-revision:'))
      )
        throw Error('Storage unavailable');
      write.call(this, key, value);
    });
    let receipt: SendMessageOptions['onDelivery'];
    let proof: SendMessageOptions['composerDraft'];
    render(
      <ChatInput
        sessionId="chat"
        running={false}
        onStop={() => {}}
        onSend={(_text, _images, _context, callback, _assigned, captured) => {
          receipt = callback;
          proof = captured;
          return true;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Accepted without storage' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(proof).toBeUndefined();
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  },
);

it('recovers ordinary late acceptance on a later rich-owner mount without a local command prop', () => {
  const draft = {
    ...createChatDraft(),
    text: 'Navigate before acceptance',
    images: [{ data: 'image', preview: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' }],
    contextBlocks: ['Submitted context'],
  };
  saveChatDraft(draft);
  let receipt: SendMessageOptions['onDelivery'];
  const props = { savedChatDraft: draft, running: false, onStop: () => {}, onSend: () => false };
  const first = render(
    <ChatInput
      {...props}
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
    />,
  );
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  first.unmount();
  act(() => receipt?.('accepted'));
  render(<ChatInput {...props} />);
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  expect(screen.queryByAltText('Attachment 1')).toBeNull();
  expect(getChatDraft(draft.id)).toBeNull();
});

it.each(['failed', 'uncertain', 'same-text', 'context', 'foreign'] as const)(
  'preserves a volatile draft after %s instead of using stale in-memory acceptance',
  (change) => {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'mitzo-draft-chat') throw Error('Draft unavailable');
      write.call(this, key, value);
    });
    let receipt: SendMessageOptions['onDelivery'];
    const props = {
      sessionId: 'chat',
      running: false,
      onStop: () => {},
      onSend: (
        _text: string,
        _images: unknown,
        _context: unknown,
        callback: SendMessageOptions['onDelivery'],
      ) => {
        receipt = callback;
        return true;
      },
    };
    const view = render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Volatile submitted text' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    if (change === 'same-text')
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Volatile submitted text' },
      });
    if (change === 'context')
      view.rerender(<ChatInput {...props} externalContextBlocks={['New context']} />);
    if (change === 'foreign') {
      const other = renderHook(() => useDraft('chat'));
      act(() => other.result.current[1]('Foreign draft'));
      other.unmount();
    }
    act(() => receipt?.(change === 'failed' || change === 'uncertain' ? change : 'accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      'Volatile submitted text',
    );
  },
);

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  'cleans only mounted rich memory when proof persistence fails (foreign edit=%s, external context=%s)',
  (foreign, external) => {
    const draft = {
      ...createChatDraft(),
      text: 'Submitted rich text',
      images: [
        { data: 'image', preview: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
      ],
      contextBlocks: ['Submitted context'],
    };
    saveChatDraft(draft);
    const write = Storage.prototype.setItem;
    const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key.startsWith('mitzo-draft-revision:')) throw Error('Revision unavailable');
      write.call(this, key, value);
    });
    let receipt: SendMessageOptions['onDelivery'];
    render(
      <ChatInput
        savedChatDraft={draft}
        externalContextBlocks={external ? draft.contextBlocks : undefined}
        running={false}
        onStop={() => {}}
        onSend={(_text, _images, _context, callback, _assigned, proof) => {
          expect(proof).toBeUndefined();
          receipt = callback;
          return true;
        }}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    fault.mockRestore();
    const retained = foreign
      ? { ...draft, text: 'Foreign rich text', contextBlocks: ['Foreign context'] }
      : draft;
    if (foreign) saveChatDraft(retained);
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      foreign ? draft.text : '',
    );
    expect(screen.queryByAltText('Attachment 1') !== null).toBe(foreign);
    expect(getChatDraft(draft.id)).toMatchObject({
      text: retained.text,
      images: retained.images,
      contextBlocks: retained.contextBlocks,
      settings: retained.settings,
    });
  },
);

it.each([false, true])(
  'preserves a newer replacement on late ordinary acceptance (same text=%s)',
  (sameText) => {
    let receipt: SendMessageOptions['onDelivery'];
    const props = { sessionId: 'chat', running: false, onStop: () => {}, onSend: () => false };
    const first = render(
      <ChatInput
        {...props}
        onSend={(_text, _images, _context, callback) => {
          receipt = callback;
          return true;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Submitted original' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    first.unmount();
    render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: 'Newer draft' } });
    if (sameText)
      fireEvent.change(screen.getByLabelText('Message Mitzo'), {
        target: { value: 'Submitted original' },
      });
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      sameText ? 'Submitted original' : 'Newer draft',
    );
  },
);

it('never clears a replacement through volatile acceptance from an unmounted composer', () => {
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('mitzo-draft-revision:')) throw Error('Revision unavailable');
    write.call(this, key, value);
  });
  let receipt: SendMessageOptions['onDelivery'];
  const props = { sessionId: 'chat', running: false, onStop: () => {}, onSend: () => false };
  const first = render(
    <ChatInput
      {...props}
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Original volatile text' },
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  first.unmount();
  render(<ChatInput {...props} />);
  act(() => receipt?.('accepted'));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Original volatile text');
});

it.each(['text', 'revision'] as const)(
  'retains volatile authority through its exact ordinary assignment with %s write failure',
  (failure) => {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (failure === 'text' ? key === 'mitzo-draft-new' : key.startsWith('mitzo-draft-revision:'))
        throw Error('Storage unavailable');
      write.call(this, key, value);
    });
    let receipt: SendMessageOptions['onDelivery'];
    let assign: SendMessageOptions['onSessionAssigned'];
    const props = {
      running: false,
      onStop: () => {},
      onSend: (
        _text: string,
        _images: unknown,
        _context: unknown,
        callback: SendMessageOptions['onDelivery'],
        assignment: SendMessageOptions['onSessionAssigned'],
      ) => {
        receipt = callback;
        assign = assignment;
        return true;
      },
    };
    const view = render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'First ordinary message' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    act(() => assign?.('assigned-chat'));
    view.rerender(<ChatInput {...props} sessionId="assigned-chat" />);
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  },
);

it('does not replace failed revocation of an existing token with volatile acceptance', () => {
  let receipt: SendMessageOptions['onDelivery'];
  render(
    <ChatInput
      sessionId="chat"
      running={false}
      onStop={() => {}}
      onSend={(_text, _images, _context, callback, _assigned, proof) => {
        expect(proof).toBeUndefined();
        receipt = callback;
        return true;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Keep the existing authority' },
  });
  const write = Storage.prototype.setItem;
  const remove = Storage.prototype.removeItem;
  const isRevision = (key: string) => key.startsWith('mitzo-draft-revision:');
  const writeFault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (isRevision(key)) throw Error('Cannot replace revision');
    write.call(this, key, value);
  });
  const removeFault = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (isRevision(key)) throw Error('Cannot revoke revision');
    remove.call(this, key);
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  act(() => receipt?.('accepted'));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
    'value',
    'Keep the existing authority',
  );
  expect(localStorage.getItem('mitzo-draft-chat')).toBe('Keep the existing authority');
  writeFault.mockRestore();
  removeFault.mockRestore();
});

it('keeps known durable authority guarded when later volatile attempts cannot read storage', () => {
  const write = Storage.prototype.setItem;
  let receipt: SendMessageOptions['onDelivery'];
  render(
    <ChatInput
      sessionId="chat"
      running={false}
      onStop={() => {}}
      onSend={(_text, _images, _context, callback) => {
        receipt = callback;
        return true;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Keep known durable authority' },
  });
  const fault = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key === 'mitzo-draft-chat') throw Error('Draft unavailable');
    write.call(this, key, value);
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  act(() => receipt?.('failed'));
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw Error('Storage unreadable');
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  act(() => receipt?.('accepted'));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
    'value',
    'Keep known durable authority',
  );
  fault.mockRestore();
});

it.each([false, true])(
  'preserves foreign same-text ABA when revision persistence is unavailable (assigned=%s)',
  (assigned) => {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('mitzo-draft-revision:')) throw Error('Revision unavailable');
      write.call(this, key, value);
    });
    let receipt: SendMessageOptions['onDelivery'];
    let assign: SendMessageOptions['onSessionAssigned'];
    const props = {
      sessionId: assigned ? undefined : 'chat',
      running: false,
      onStop: () => {},
      onSend: (
        _text: string,
        _images: unknown,
        _context: unknown,
        callback: SendMessageOptions['onDelivery'],
        assignment: SendMessageOptions['onSessionAssigned'],
      ) => {
        receipt = callback;
        assign = assignment;
        return true;
      },
    };
    const view = render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Same text in another editor' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    const other = renderHook(() => useDraft(props.sessionId));
    act(() => {
      other.result.current[1]('Foreign intermediate text');
      other.result.current[1]('Same text in another editor');
      other.result.current[3]();
    });
    other.unmount();
    if (assigned) {
      act(() => assign?.('assigned-chat'));
      view.rerender(<ChatInput {...props} sessionId="assigned-chat" />);
    }
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
      'value',
      'Same text in another editor',
    );
  },
);

it.each([false, true])(
  'recovers durable acceptance after exact session assignment and unmount (replacement first=%s)',
  (replacementFirst) => {
    let receipt: SendMessageOptions['onDelivery'];
    let assign: SendMessageOptions['onSessionAssigned'];
    const props = { running: false, onStop: () => {}, onSend: () => false };
    const first = render(
      <ChatInput
        {...props}
        onSend={(_text, _images, _context, callback, assigned) => {
          receipt = callback;
          assign = assigned;
          return true;
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'Assigned ordinary request' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    act(() => assign?.('assigned-chat'));
    first.rerender(<ChatInput {...props} sessionId="assigned-chat" />);
    first.unmount();
    if (replacementFirst) render(<ChatInput {...props} sessionId="assigned-chat" />);
    act(() => receipt?.('accepted'));
    if (!replacementFirst) render(<ChatInput {...props} sessionId="assigned-chat" />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
    expect(localStorage.getItem('mitzo-draft-assigned-chat')).toBeNull();
  },
);

it('retains the exact assigned receipt owner after the same mount navigates elsewhere', () => {
  let receipt: SendMessageOptions['onDelivery'];
  let assign: SendMessageOptions['onSessionAssigned'];
  const props = { running: false, onStop: () => {}, onSend: () => false };
  const first = render(
    <ChatInput
      {...props}
      onSend={(_text, _images, _context, callback, assigned) => {
        receipt = callback;
        assign = assigned;
        return true;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Assigned request before navigation' },
  });
  fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
  act(() => assign?.('assigned-chat'));
  first.rerender(<ChatInput {...props} sessionId="assigned-chat" />);
  first.rerender(<ChatInput {...props} sessionId="other-chat" />);
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Keep the other conversation' },
  });
  act(() => receipt?.('accepted'));
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
    'value',
    'Keep the other conversation',
  );
  first.unmount();
  render(<ChatInput {...props} sessionId="assigned-chat" />);
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', '');
  expect(localStorage.getItem('mitzo-draft-assigned-chat')).toBeNull();
});

it.each(['ordinary', 'rich'] as const)(
  'revokes the submitted %s revision when genuine New reuses its storage owner and text',
  (kind) => {
    const draft = {
      ...createChatDraft(),
      text: 'Same intended prompt',
      images: [
        { data: 'image', preview: 'data:image/png;base64,aW1hZ2U=', mediaType: 'image/png' },
      ],
      contextBlocks: ['Keep this context'],
    };
    if (kind === 'rich') saveChatDraft(draft);
    let receipt: SendMessageOptions['onDelivery'];
    let proof: SendMessageOptions['composerDraft'];
    const props = {
      sessionId: undefined,
      savedChatDraft: kind === 'rich' ? draft : undefined,
      running: false,
      onStop: () => {},
      onSend: () => false,
    };
    const view = render(
      <ChatInput
        {...props}
        composerGeneration={0}
        onSend={(_text, _images, _context, callback, _assignment, captured) => {
          receipt = callback;
          proof = captured;
          return true;
        }}
      />,
    );
    if (kind === 'ordinary')
      fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: draft.text } });
    fireEvent.keyDown(screen.getByLabelText('Message Mitzo'), { key: 'Enter' });
    expect(proof).toBeDefined();
    view.rerender(<ChatInput {...props} composerGeneration={1} />);
    // Same-value input can be a DOM no-op; New itself must revoke the receipt.
    fireEvent.change(screen.getByLabelText('Message Mitzo'), { target: { value: draft.text } });
    act(() => receipt?.('accepted'));
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', draft.text);
    expect(localStorage.getItem(acceptedComposerDraftKey(proof!.storageKey))).toBeNull();
    if (kind === 'rich') {
      expect(screen.getByAltText('Attachment 1')).toBeTruthy();
      expect(getChatDraft(draft.id)).toMatchObject({
        text: draft.text,
        images: draft.images,
        contextBlocks: draft.contextBlocks,
      });
    }
    // Neither a retained journal nor a direct cold receipt may revive the
    // superseded generation after its composer leaves.
    localStorage.setItem(acceptedComposerDraftKey(proof!.storageKey), JSON.stringify(proof));
    view.unmount();
    render(<ChatInput {...props} composerGeneration={1} acceptedComposerDraft={proof} />);
    expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', draft.text);
  },
);
