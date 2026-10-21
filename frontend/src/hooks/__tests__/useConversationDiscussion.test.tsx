// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useConversationJoiningApplication } from '../useConversationJoiningApplication';
import { useConversationDiscussion } from '../useConversationDiscussion';
import { joiningApplicationHarness } from '../../test-utils/conversation-joining-application-harness';
import { createChatDraft, saveChatDraft, getChatDraft } from '../../lib/chat-drafts';
import * as auth from '../../lib/api-fetch';
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps a foreign rich recipient draft intact and visibly unavailable instead of impersonating a legacy upgrade', async () => {
  joiningApplicationHarness('00000000-0000-4000-8000-000000000010', ['source-chat', 'peer']);
  const draft = {
    ...createChatDraft(),
    text: 'Exact independent bytes',
    settings: {
      ...createChatDraft().settings,
      collaborationResponders: {
        collaborationId: '00000000-0000-4000-8000-000000000099',
        responders: { kind: 'all' as const },
      },
    },
  };
  saveChatDraft(draft);
  const before = getChatDraft(draft.id);
  const hook = renderHook(() => {
    const joining = useConversationJoiningApplication({
      sourceConversationId: 'source-chat',
      clientId: 'live-client',
      routeKey: 'route-a',
    });
    return useConversationDiscussion({
      joining,
      source: { id: 'source-chat', name: 'Original agent', state: 'Current' },
      draftId: draft.id,
    });
  });
  await waitFor(() => expect(hook.result.current.presentation.projection).not.toBeNull());
  expect(hook.result.current.canChooseRecipients()).toBe(false);
  expect(hook.result.current.responders?.disabled).toBe(true);
  expect(hook.result.current.recipientReason).toContain('another conversation');
  expect(getChatDraft(draft.id)).toEqual(before);
});
