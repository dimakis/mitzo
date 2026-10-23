// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  launchDraftDelivery,
  reviewedBriefingLaunch,
  validateOwnedBriefingAssignment,
} from '../launch-draft-delivery';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { buildLocalFirstCommand } from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
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

function ownedFixture() {
  const base = localInventoryFixture();
  const inventory = {
    ...base,
    routes: base.routes.map((route) => ({ ...route, capabilityRevision: 'selected-route-r1' })),
  };
  const account = { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' };
  const source = {
    kind: 'briefing' as const,
    date: '2026-10-15',
    revision: 'a'.repeat(64),
    content: 'Original report',
  };
  const draft = createChatDraft();
  draft.text = 'Discuss the report';
  draft.settings.selection = account;
  draft.settings.runtimeSelection = {
    ...createChatRuntimeSelection(),
    account,
    accountReference: inventory.accounts[0].account,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local', targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
  };
  draft.settings.launch = {
    prompt: draft.text,
    context: 'Original context',
    briefing: source,
    accountSelection: account,
    sourceSnapshots: [source],
  };
  saveChatDraft(draft);
  draft.settings.launch = reviewedBriefingLaunch(draft, draft.settings.runtimeSelection, inventory);
  saveChatDraft(draft);
  const command = buildLocalFirstCommand(draft.settings.runtimeSelection, inventory, {
    clientMsgId: 'owned-distinct-revisions',
    mode: 'agent',
    text: draft.text,
    sourceSnapshots: [source],
  })!;
  return { draft, command, inventory };
}
it('prepares and cold-validates original selected-route proof independently of combined inventory revision', () => {
  const { draft, command } = ownedFixture();
  expect(command.capabilityRevision).not.toBe(draft.settings.runtimeSelection!.capabilityRevision);
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(true);
  launchDraftDelivery.settle(command.clientMsgId, 'uncertain');
  draft.settings.launch!.reviewedRoute!.capabilityRevision = 'later-route';
  draft.settings.runtimeSelection!.capabilityRevision = 'later-inventory';
  saveChatDraft(draft);
  expect(validateOwnedBriefingAssignment(draft.id, command)).toBe(true);
  expect(
    validateOwnedBriefingAssignment(draft.id, { ...command, capabilityRevision: 'later-route' }),
  ).toBe(false);
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(false);
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
});
it('refuses a selected-route revision changing inside the same reviewed combined inventory', () => {
  const { draft, command, inventory } = ownedFixture();
  inventory.routes[0].capabilityRevision = 'changed-route';
  const launch = reviewedBriefingLaunch(draft, draft.settings.runtimeSelection!, inventory);
  expect(launch?.reviewedRoute?.capabilityRevision).toBe('selected-route-r1');
  saveChatDraft({ ...draft, settings: { ...draft.settings, launch } });
  expect(
    launchDraftDelivery.prepare(draft.id, { ...command, capabilityRevision: 'changed-route' }),
  ).toBe(false);
  expect(launchDraftDelivery.pending(draft.id)).toBe(false);
});
it('requires review after an unrelated combined refresh without changing the selected route evidence', () => {
  const { draft, inventory } = ownedFixture();
  inventory.capabilityRevision = 'unrelated-inventory-refresh';
  expect(
    buildLocalFirstCommand(draft.settings.runtimeSelection!, inventory, {
      clientMsgId: 'stale',
      mode: 'agent',
      text: draft.text,
    }),
  ).toBeNull();
  expect(
    reviewedBriefingLaunch(draft, draft.settings.runtimeSelection!, inventory)?.reviewedRoute
      ?.inventoryRevision,
  ).toBe('caps-r1');
  draft.settings.runtimeSelection!.capabilityRevision = inventory.capabilityRevision;
  const launch = reviewedBriefingLaunch(draft, draft.settings.runtimeSelection!, inventory);
  expect(launch?.reviewedRoute).toMatchObject({
    inventoryRevision: 'unrelated-inventory-refresh',
    capabilityRevision: 'selected-route-r1',
  });
});
it.each([
  'capabilityRevision',
  'inventoryRevision',
  'targetId',
  'harness',
  'account',
  'location',
] as const)('rejects changed original retained route %s before assignment', (field) => {
  const { draft, command } = ownedFixture();
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(true);
  const key = Object.keys(localStorage).find((key) => key.startsWith('mitzo-launch-delivery:'))!;
  const receipt = JSON.parse(localStorage.getItem(key)!);
  const route = receipt.submitted.settings.launch.reviewedRoute;
  if (field === 'account') route.account.accountId = 'other';
  else
    route[field] =
      field === 'harness' ? 'claude-sdk' : field === 'location' ? 'openshell' : 'changed';
  localStorage.setItem(key, JSON.stringify(receipt));
  expect(validateOwnedBriefingAssignment(draft.id, command)).toBe(false);
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
});

it('keeps historical same-revision owned receipts valid without inventing route evidence', () => {
  const { draft, command } = ownedFixture();
  delete draft.settings.launch!.reviewedRoute;
  draft.settings.runtimeSelection!.capabilityRevision = command.capabilityRevision;
  saveChatDraft(draft);
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(true);
  expect(validateOwnedBriefingAssignment(draft.id, command)).toBe(true);
});
it('refuses distinct revisions when the original selected-route proof is absent', () => {
  const { draft, command } = ownedFixture();
  delete draft.settings.launch!.reviewedRoute;
  saveChatDraft(draft);
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(false);
  expect(launchDraftDelivery.pending(draft.id)).toBe(false);
});
