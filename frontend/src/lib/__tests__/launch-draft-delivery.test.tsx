// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { launchDraftDelivery } from '../launch-draft-delivery';
import {
  createChatDraft,
  getChatDraft,
  listChatDrafts,
  saveChatDraft,
  chatDraftTextKey,
} from '../chat-drafts';
import { useDraft } from '../../hooks/useDraft';
import { createTestStore } from '../../test-utils/createTestStore';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});
function fixture() {
  const launch = {
    prompt: 'Reviewed prompt',
    context: 'Task',
    accountSelection: { accountId: 'work', model: 'luna' },
  };
  const draft = {
    ...createChatDraft(),
    text: launch.prompt,
    settings: { ...createChatDraft().settings, selection: launch.accountSelection, launch },
  };
  saveChatDraft(draft);
  const command = {
    clientMsgId: 'original-command',
    prompt: launch.prompt,
    accountId: 'work',
    model: 'luna',
  };
  return { draft, launch: { ...launch, draftId: draft.id }, command };
}
it('restores the command lock in a new client and reconciles only its matching receipt', () => {
  const { draft, launch, command } = fixture();
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(true);
  const fresh = createTestStore({ launchDrafts: launchDraftDelivery });
  const send = vi.fn();
  fresh.setState({ sendMessage: send });
  fresh.getState().setPendingSession(launch);
  expect(fresh.getState().pendingSessionSending).toBe(true);
  expect(fresh.getState().sendPendingSession()).toBe(false);
  expect(send).not.toHaveBeenCalled();
  launchDraftDelivery.settle('unrelated', 'accepted');
  expect(getChatDraft(draft.id)).not.toBeNull();
  launchDraftDelivery.assign(command.clientMsgId, 'assigned');
  launchDraftDelivery.settle(command.clientMsgId, 'accepted');
  expect(getChatDraft(draft.id)).toBeNull();
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
});
it('releases a persisted lock only on a definitive rejection', () => {
  const { draft, command } = fixture();
  launchDraftDelivery.prepare(draft.id, command);
  launchDraftDelivery.settle(command.clientMsgId, 'uncertain');
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
  launchDraftDelivery.settle(command.clientMsgId, 'failed');
  expect(launchDraftDelivery.pending(draft.id)).toBe(false);
  expect(getChatDraft(draft.id)?.text).toBe(command.prompt);
});
it('preserves unsent follow-up text independently when accepting the reviewed launch', () => {
  const { draft, command } = fixture();
  localStorage.setItem(chatDraftTextKey(draft.id), 'Unsent follow-up');
  launchDraftDelivery.prepare(draft.id, command);
  launchDraftDelivery.settle(command.clientMsgId, 'accepted');
  expect(getChatDraft(draft.id)).toBeNull();
  expect(listChatDrafts()).toEqual([
    expect.objectContaining({
      text: 'Unsent follow-up',
      settings: expect.not.objectContaining({ launch: expect.anything() }),
    }),
  ]);
});
it('preserves even a follow-up whose debounce has not flushed when the launch is accepted', () => {
  vi.useFakeTimers();
  const { draft, command } = fixture();
  const hook = renderHook(({ session, key }) => useDraft(session, undefined, key), {
    initialProps: {
      session: undefined as string | undefined,
      key: chatDraftTextKey(draft.id) as string | undefined,
    },
  });
  act(() => hook.result.current[1]('Latest unsent follow-up'));
  launchDraftDelivery.prepare(draft.id, command);
  launchDraftDelivery.settle(command.clientMsgId, 'accepted');
  hook.rerender({ session: 'assigned', key: undefined });
  expect(listChatDrafts().some((entry) => entry.text === 'Latest unsent follow-up')).toBe(true);
});
it('refuses dispatch if its durable association cannot be saved', () => {
  const { draft, command } = fixture();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw new Error('quota');
  });
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(false);
  expect(getChatDraft(draft.id)).not.toBeNull();
  vi.restoreAllMocks();
});

it('keeps acceptance terminal when a delayed rejection arrives', () => {
  const { draft, command } = fixture();
  launchDraftDelivery.prepare(draft.id, command);
  launchDraftDelivery.settle(command.clientMsgId, 'accepted');
  launchDraftDelivery.settle(command.clientMsgId, 'failed');
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
});
it('isolates corrupt recovery metadata from other command receipts', () => {
  localStorage.setItem('mitzo-launch-delivery::broken', 'bad-json');
  const { draft, command } = fixture();
  launchDraftDelivery.prepare(draft.id, command);
  expect(() => launchDraftDelivery.settle(command.clientMsgId, 'accepted')).not.toThrow();
  expect(getChatDraft(draft.id)).toBeNull();
});

it('flushes a launch follow-up before page replacement without waiting for the debounce', () => {
  const { draft } = fixture();
  const hook = renderHook(() => useDraft(undefined, undefined, chatDraftTextKey(draft.id)));
  act(() => hook.result.current[1]('Reload this follow-up'));
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(localStorage.getItem(chatDraftTextKey(draft.id))).toBe('Reload this follow-up');
});
