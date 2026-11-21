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

it('retains recorded shared timestamps and image previews without inventing historical times', () => {
  const view = sharedConversationView();
  view.messages[0] = {
    ...view.messages[0],
    recordedAt: 1794814800000,
    images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
  };
  const projected = conversationMessages(view);
  expect(projected[0].timestamp).toBe(1794814800000);
  expect(projected[0].images).toEqual(['data:image/png;base64,aGVsbG8=']);
  expect(projected[1]).not.toHaveProperty('timestamp');
});

it('presents an automated assignment as its agent origin and keeps canonical reply linkage', () => {
  const view = sharedConversationView();
  view.messages[0] = {
    ...view.messages[0],
    origin: { sessionId: 'reader', requestId: view.messages[0].messageId },
  };
  const projected = conversationMessages(view);
  expect(projected[0].role).toBe('assistant');
  expect(projected[1].replyToMessageId).toBe(view.messages[0].projectionId);
  expect(projected[1].inReplyTo).toMatchObject({
    messageId: view.messages[0].projectionId,
    text: view.messages[0].text,
    role: 'assistant',
  });
});
