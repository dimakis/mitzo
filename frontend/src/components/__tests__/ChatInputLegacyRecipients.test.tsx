// @vitest-environment jsdom
import { useCallback, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import {
  CHAT_DRAFTS_CHANGED,
  createChatDraft,
  getSessionChatDraft,
  saveChatDraft,
  writeLegacyChatDraft,
} from '../../lib/chat-drafts';
import type { ChatDraft } from '../../lib/chat-drafts';
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
vi.mock('../../lib/resizeImage', () => ({
  resizeImage: vi.fn(async () => ({
    data: 'exact-image',
    preview: 'data:image/png;base64,eA==',
    mediaType: 'image/png',
  })),
}));
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, body: () => unknown) => body() },
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});
const group = '00000000-0000-4000-8000-000000000001';
const context = ['exact-context'];
const settings = {
  ...createChatDraft().settings,
  mode: 'ask' as const,
  selection: { accountId: 'personal', model: 'luna-fixture' },
  search: 'exact=unchanged',
};
function Host({ allowed = true }: { allowed?: boolean }) {
  const [rich, setRich] = useState(() => getSessionChatDraft('source-chat'));
  const [, tick] = useState(0);
  const isCurrent = useCallback(() => allowed, [allowed]);
  useEffect(() => {
    const update = () => {
      const next = getSessionChatDraft('source-chat');
      const content = (v: ChatDraft | null) => JSON.stringify(v && { ...v, updatedAt: 0 });
      setRich((old) => (content(old) === content(next) ? old : next));
      tick((v) => v + 1);
    };
    window.addEventListener(CHAT_DRAFTS_CHANGED, update);
    return () => window.removeEventListener(CHAT_DRAFTS_CHANGED, update);
  }, []);
  return (
    <ChatInput
      sessionId="source-chat"
      savedChatDraft={rich ?? undefined}
      running={false}
      sendDisabledReason="Shared delivery unavailable"
      onSend={() => false}
      onStop={() => {}}
      externalContextBlocks={context}
      legacyRecipientUpgrade={!rich ? { collaborationId: group, settings, isCurrent } : undefined}
      responders={{
        members: [{ id: 'peer', name: 'Reviewer', repliesByDefault: true }],
        selectedIds: ['peer'],
        responders: rich?.settings.collaborationResponders?.responders ?? { kind: 'default' },
        onChange: (_ids, intent) =>
          rich && intent
            ? saveChatDraft({
                ...rich,
                settings: {
                  ...rich.settings,
                  collaborationResponders: { collaborationId: group, responders: intent },
                },
              })
            : false,
      }}
    />
  );
}
it('copies latest text, actual pending attachment/context/settings only on @ choice, retaining the same editor and rich ID', async () => {
  localStorage.setItem('mitzo-draft-source-chat', 'Original body');
  const { container } = render(<Host />);
  expect(getSessionChatDraft('source-chat')).toBeNull();
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(container.querySelector('input[type=file]')!, {
    target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(screen.getByAltText('Attachment 1')).toBeTruthy());
  input.focus();
  fireEvent.change(input, { target: { value: '  Latest edited body @all' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(
      getSessionChatDraft('source-chat')?.settings.collaborationResponders?.responders,
    ).toEqual({ kind: 'all' }),
  );
  const rich = getSessionChatDraft('source-chat')!;
  expect(rich).toMatchObject({
    text: '  Latest edited body ',
    images: [{ data: 'exact-image', mediaType: 'image/png' }],
    contextBlocks: ['exact-context'],
    settings,
  });
  await waitFor(() => expect(input.value).toBe('  Latest edited body '));
  expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('  Latest edited body @all');
  act(() => writeLegacyChatDraft('source-chat', 'Late other-editor body'));
  expect(getSessionChatDraft('source-chat')!.id).toBe(rich.id);
  expect(getSessionChatDraft('source-chat')!.images).toEqual(rich.images);
  expect(input.value).toBe('  Latest edited body ');
  expect(screen.getByText(/Another editor changed/)).toBeTruthy();
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('Late other-editor body');
});
it('keeps edited text and original pending ID after quota failure and recovers it on the same explicit choice', async () => {
  localStorage.setItem('mitzo-draft-source-chat', 'Original');
  render(<Host />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  const originalSet = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith('mitzo-chat-draft:')) throw Error('Quota');
    originalSet.call(this, key, value);
  });
  input.focus();
  fireEvent.change(input, { target: { value: 'Exact retained body @all' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('alert');
  const pending = JSON.parse(localStorage.getItem('mitzo-chat-draft-session:source-chat')!);
  expect(input.value).toBe('Exact retained body @all');
  expect(pending.state).toBe('pending_upgrade');
  spy.mockRestore();
  fireEvent.click(await screen.findByRole('button', { name: 'All agents' }));
  await waitFor(() => expect(getSessionChatDraft('source-chat')?.id).toBe(pending.draftId));
  await waitFor(() => expect(input.value).toBe('Exact retained body '));
});
it('refuses a queued explicit choice when the live editor is changed or its scope retires before locking', async () => {
  localStorage.setItem('mitzo-draft-source-chat', 'Original');
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, body: () => unknown) => {
        await waiting;
        return body();
      },
    },
  });
  const host = render(<Host />);
  const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Original choice @all' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'Newer human body with no lost bytes' } });
  host.rerender(<Host allowed={false} />);
  await act(async () => {
    release();
    await waiting;
  });
  expect(getSessionChatDraft('source-chat')).toBeNull();
  expect(localStorage.getItem('mitzo-chat-draft-session:source-chat')).toBeNull();
  expect(input.value).toBe('Newer human body with no lost bytes');
});
