import { expect, it } from 'vitest';
import { conversationMessages, conversationResponders } from '../conversation-presentation';
import {
  sharedConversationView,
  sharedReply,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

it('projects the actual attributed reply with a stable projection key and no invented legacy provenance', () => {
  const view = sharedConversationView();
  const messages = conversationMessages(view);
  expect(messages.map((m) => m.messageId)).toEqual(view.messages.map((m) => m.projectionId));
  expect(messages[1]).toMatchObject({ role: 'assistant', blocks: [{ content: sharedReply.text }] });
  expect(messages[1]).not.toHaveProperty('symposiumProvenance');
  expect(messages[1]).not.toHaveProperty('timestamp');
  expect(messages[1]).not.toHaveProperty('completedSeq');
});

it('keeps protocol default/explicit empty/all intents separate and exposes unavailable recipients', () => {
  const view = sharedConversationView();
  const defaults = conversationResponders(view, { kind: 'default' }, { architect: 'Architect' });
  expect(defaults.selectedIds).toEqual(['architect']);
  expect(defaults.members.find((m) => m.id === 'reader')?.repliesByDefault).toBe(false);
  expect(defaults.sendDisabledReason).toBe(view.execution.reason);
  expect(conversationResponders(view, { kind: 'selected', sessionIds: [] }).selectedIds).toEqual(
    [],
  );
  expect(conversationResponders(view, { kind: 'all' }).selectedIds).toEqual(
    view.participantSessionIds,
  );
  view.unavailableParticipantSessionIds = ['reviewer'];
  const selected = conversationResponders(view, {
    kind: 'selected',
    sessionIds: ['reviewer', 'removed'],
  });
  expect(selected.selectedIds).toEqual(['reviewer', 'removed']);
  expect(selected.members.find((m) => m.id === 'reviewer')?.unavailableReason).toBeTruthy();
});
