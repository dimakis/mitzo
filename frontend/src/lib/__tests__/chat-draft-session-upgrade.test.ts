// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  upgradeSessionChatDraft,
  getSessionChatDraft,
  createChatDraft,
  saveChatDraft,
  bindChatDraftToSession,
  getChatDraft,
  consumeChatDraft,
  writeLegacyChatDraft,
  hasConcurrentLegacyChatDraft,
  CHAT_DRAFTS_CHANGED,
} from '../chat-drafts';
import { useDraft } from '../../hooks/useDraft';
const sessionId = 'source-chat',
  key = 'mitzo-chat-draft-session:source-chat';
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
beforeEach(() => {
  localStorage.clear();
  let queue = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, body: () => unknown) => {
        const next = queue.then(body);
        queue = next.then(
          () => {},
          () => {},
        );
        return next;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
  else Reflect.deleteProperty(navigator, 'locks');
});
function input() {
  localStorage.setItem('mitzo-draft-source-chat', 'Original legacy bytes');
  return {
    sessionId,
    expectedLegacyText: 'Original legacy bytes',
    isCurrent: () => true,
    content: {
      text: ' Exact latest edited body  ',
      images: [{ data: 'exact-image', preview: 'exact-preview', mediaType: 'image/png' }],
      contextBlocks: ['exact-context'],
    },
    settings: {
      ...createChatDraft().settings,
      mode: 'ask' as const,
      collaborationResponders: {
        collaborationId: '00000000-0000-4000-8000-000000000001',
        responders: { kind: 'selected' as const, sessionIds: ['peer'] },
      },
    },
  };
}
it('upgrades only an explicit exact snapshot in the existing owner while retaining original legacy bytes', async () => {
  const request = input();
  expect(getSessionChatDraft(sessionId)).toBeNull();
  const result = await upgradeSessionChatDraft(request);
  expect(result.state).toBe('upgraded');
  expect(getSessionChatDraft(sessionId)).toMatchObject({
    ...request.content,
    settings: request.settings,
  });
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe(request.expectedLegacyText);
  const repeat = await upgradeSessionChatDraft(request);
  expect(repeat).toMatchObject({
    state: 'upgraded',
    draft: { id: getSessionChatDraft(sessionId)!.id },
  });
});
it.each([
  ['reserve', false],
  ['reserve', true],
  ['rich', false],
  ['rich', true],
  ['assignment', false],
  ['assignment', true],
  ['commit', false],
  ['commit', true],
] as const)(
  'recovers %s quota/lost-write (%s) using the retained original identity',
  async (stage, after) => {
    const request = input(),
      original = Storage.prototype.setItem;
    let failed = false,
      reservedId: string | undefined;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      name,
      value,
    ) {
      const data = JSON.parse(value.startsWith('{') ? value : '{}');
      if (name === key && data.state === 'pending_upgrade') reservedId = data.draftId;
      const matches =
        stage === 'reserve'
          ? name === key && data.state === 'pending_upgrade'
          : stage === 'rich'
            ? name.startsWith('mitzo-chat-draft:')
            : stage === 'assignment'
              ? name.startsWith('mitzo-chat-draft-assignment:')
              : name === key && data.state === 'upgraded';
      if (!failed && matches) {
        failed = true;
        if (after) original.call(this, name, value);
        throw Error('Quota or response lost');
      }
      original.call(this, name, value);
    });
    expect((await upgradeSessionChatDraft(request)).state).toBe('failed');
    const retained = localStorage.getItem(key);
    spy.mockRestore();
    const result = await upgradeSessionChatDraft(request);
    expect(result.state).toBe('upgraded');
    if (retained) expect(getSessionChatDraft(sessionId)!.id).toBe(reservedId);
    expect(getSessionChatDraft(sessionId)).toMatchObject(request.content);
    expect(localStorage.getItem('mitzo-draft-source-chat')).toBe(request.expectedLegacyText);
  },
);
it('never overwrites independent rich ownership or a late human edit to a pending rich draft', async () => {
  const independent = { ...createChatDraft(), text: 'Independent rich body' };
  saveChatDraft(independent);
  expect(bindChatDraftToSession(independent.id, sessionId)).toBe('bound');
  const request = input();
  expect(await upgradeSessionChatDraft(request)).toMatchObject({
    state: 'existing',
    draftId: independent.id,
  });
  expect(getChatDraft(independent.id)!.text).toBe(independent.text);
  localStorage.clear();
  const pending = input();
  const listener = () => {
    const value = JSON.parse(localStorage.getItem(key)!);
    if (value?.state === 'pending_upgrade') {
      window.removeEventListener(CHAT_DRAFTS_CHANGED, listener);
      saveChatDraft({ ...value.draft, text: 'Late independent rich edit' });
    }
  };
  window.addEventListener(CHAT_DRAFTS_CHANGED, listener);
  expect((await upgradeSessionChatDraft(pending)).state).toBe('conflict');
  const id = JSON.parse(localStorage.getItem(key)!).draftId;
  expect((await upgradeSessionChatDraft(pending)).state).toBe('conflict');
  expect(getChatDraft(id)!.text).toBe('Late independent rich edit');
});
it.each(['legacy', 'retired'] as const)(
  'preserves bytes when a reentrant %s change interrupts publication',
  async (change) => {
    const request = input();
    let current = true;
    request.isCurrent = () => current;
    const listener = () => {
      window.removeEventListener(CHAT_DRAFTS_CHANGED, listener);
      if (change === 'legacy') writeLegacyChatDraft(sessionId, 'Late human legacy edit');
      else current = false;
    };
    window.addEventListener(CHAT_DRAFTS_CHANGED, listener);
    expect((await upgradeSessionChatDraft(request)).state).not.toBe('upgraded');
    const record = JSON.parse(localStorage.getItem(key)!);
    expect(record.state).toBe('pending_upgrade');
    expect(getChatDraft(record.draftId)).toMatchObject(request.content);
    expect(localStorage.getItem('mitzo-draft-source-chat')).toBe(
      change === 'legacy' ? 'Late human legacy edit' : request.expectedLegacyText,
    );
    expect(getSessionChatDraft(sessionId)).toBeNull();
  },
);
it('serializes two explicit upgrades to one retained binding, rejecting a changed competing snapshot', async () => {
  const request = input();
  const [first, second] = await Promise.all([
    upgradeSessionChatDraft(request),
    upgradeSessionChatDraft({ ...request, content: { ...request.content, text: 'Other editor' } }),
  ]);
  expect(first.state).toBe('upgraded');
  expect(second.state).toBe('existing');
  expect(getSessionChatDraft(sessionId)).toMatchObject(request.content);
});
it('does not resurrect retired legacy bytes after rich consumption and respects a later same-text legacy edit', async () => {
  const request = input();
  await upgradeSessionChatDraft(request);
  const rich = getSessionChatDraft(sessionId)!;
  consumeChatDraft(rich);
  const quiet = renderHook(() => useDraft(sessionId));
  expect(quiet.result.current[0]).toBe('');
  quiet.unmount();
  writeLegacyChatDraft(sessionId, request.expectedLegacyText);
  const later = renderHook(() => useDraft(sessionId));
  expect(later.result.current[0]).toBe(request.expectedLegacyText);
});
it('refuses unavailable locking or stale expected legacy ownership before retaining an ID', async () => {
  const request = input();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  expect((await upgradeSessionChatDraft(request)).state).toBe('failed');
  expect(localStorage.getItem(key)).toBeNull();
});
it('flushes exact live edited text before upgrade and refuses a later external owner without overwriting it', () => {
  localStorage.setItem('mitzo-draft-source-chat', 'Original');
  const composer = renderHook(() => useDraft(sessionId));
  act(() => composer.result.current[1]('Latest unsaved text'));
  let reference;
  act(() => {
    reference = composer.result.current[4]();
  });
  expect(reference).toEqual({ sessionId, expectedLegacyText: 'Latest unsaved text' });
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('Latest unsaved text');
  localStorage.setItem('mitzo-draft-source-chat', 'Other editor owns newer bytes');
  expect(composer.result.current[4]()).toBeNull();
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('Other editor owns newer bytes');
});

it('permits a new draft identity only after known explicit consumption, never from unexplained missing rich bytes', async () => {
  const request = input();
  await upgradeSessionChatDraft(request);
  const first = getSessionChatDraft(sessionId)!;
  localStorage.removeItem(`mitzo-chat-draft:${first.id}`);
  expect(await upgradeSessionChatDraft(request)).toMatchObject({
    state: 'existing',
    draftId: first.id,
  });
  saveChatDraft(first);
  expect(consumeChatDraft(first)).toBe(true);
  expect(JSON.parse(localStorage.getItem(key)!).state).toBe('retired');
  writeLegacyChatDraft(sessionId, 'New explicit body');
  const next = await upgradeSessionChatDraft({
    ...request,
    expectedLegacyText: 'New explicit body',
    content: { ...request.content, text: 'New explicit body' },
  });
  expect(next.state).toBe('upgraded');
  expect(getSessionChatDraft(sessionId)!.id).not.toBe(first.id);
});

it('preserves an unrelated retired binding instead of replacing its identity under the wrong session key', async () => {
  const request = input();
  const record = {
    version: 2,
    state: 'retired',
    sessionId: 'other-source',
    draftId: '00000000-0000-4000-8000-000000000088',
    legacyText: request.expectedLegacyText,
    legacyEdited: false,
  };
  localStorage.setItem(key, JSON.stringify(record));
  expect(await upgradeSessionChatDraft(request)).toEqual({
    state: 'conflict',
    draftId: record.draftId,
  });
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual(record);
});

it('preserves a same-text legacy edit injected immediately before the final upgraded session marker, including after rich consumption', async () => {
  const request = input();
  const originalSet = Storage.prototype.setItem;
  let injected = false;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    const record = value.startsWith('{') ? JSON.parse(value) : null;
    if (!injected && name === key && record?.state === 'upgraded') {
      injected = true;
      // This occurs after the upgrade's final check/legacy read, not at the
      // earlier saveChatDraft notification covered by the other reentrant case.
      writeLegacyChatDraft(sessionId, request.expectedLegacyText);
      expect(JSON.parse(localStorage.getItem(key)!).legacyEdited).toBe(true);
    }
    originalSet.call(this, name, value);
  });
  const result = await upgradeSessionChatDraft(request);
  expect(injected).toBe(true);
  expect(result.state).toBe('conflict');
  expect(hasConcurrentLegacyChatDraft(sessionId)).toBe(true);
  const rich = getSessionChatDraft(sessionId)!;
  expect(rich).toMatchObject(request.content);
  expect(await upgradeSessionChatDraft(request)).toMatchObject({
    state: 'conflict',
    draftId: rich.id,
  });
  expect(getSessionChatDraft(sessionId)!.id).toBe(rich.id);
  expect(consumeChatDraft(rich)).toBe(true);
  const legacy = renderHook(() => useDraft(sessionId));
  expect(legacy.result.current[0]).toBe(request.expectedLegacyText);
});

it('does not change an unrelated assignment while invalidating this session’s legacy edit', async () => {
  const request = input();
  await upgradeSessionChatDraft(request);
  const rich = getSessionChatDraft(sessionId)!;
  const assignmentKey = `mitzo-chat-draft-assignment:${encodeURIComponent(rich.id)}`;
  const unrelated = {
    ...JSON.parse(localStorage.getItem(assignmentKey)!),
    sessionId: 'other-source',
  };
  localStorage.setItem(assignmentKey, JSON.stringify(unrelated));
  writeLegacyChatDraft(sessionId, 'Latest legacy edit');
  expect(JSON.parse(localStorage.getItem(assignmentKey)!)).toEqual(unrelated);
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('Latest legacy edit');
  expect(getChatDraft(rich.id)).toMatchObject(request.content);
});

it('preserves damaged assignment metadata without preventing the legacy owner from saving its human edit', async () => {
  const request = input();
  await upgradeSessionChatDraft(request);
  const rich = getSessionChatDraft(sessionId)!;
  const assignmentKey = `mitzo-chat-draft-assignment:${encodeURIComponent(rich.id)}`;
  localStorage.setItem(assignmentKey, 'damaged retained metadata');
  writeLegacyChatDraft(sessionId, 'Latest legacy bytes stay writable');
  expect(localStorage.getItem(assignmentKey)).toBe('damaged retained metadata');
  expect(localStorage.getItem('mitzo-draft-source-chat')).toBe('Latest legacy bytes stay writable');
  expect(getChatDraft(rich.id)).toMatchObject(request.content);
});
