import { expect, it } from 'vitest';
import type { SessionActivity } from '@mitzo/protocol';
import { conversationActivities } from '../conversation-activity';
import { mergeSessionActivities } from '../session-activity';

const activity = (
  sessionId: string,
  state: SessionActivity['state'],
  at: number,
): SessionActivity => ({
  sessionId,
  clientId: sessionId,
  title: sessionId,
  state,
  flags: [state],
  lastEventAt: at,
  presentationConversation: { id: 'source', title: 'Original conversation' },
});

it('keeps one navigation row while preserving participant approval and working evidence', () => {
  const working = activity('peer-working', 'working', 20);
  const approval = {
    ...activity('peer-approval', 'waiting', 10),
    waitReason: 'permission' as const,
  };
  const raw = [working, approval];
  const grouped = conversationActivities(raw);
  expect(grouped).toEqual([
    expect.objectContaining({
      sessionId: 'source',
      title: 'Original conversation',
      state: 'waiting',
      waitReason: 'permission',
      lastEventAt: 20,
      participantActivities: raw,
    }),
  ]);
  expect([
    ...mergeSessionActivities(
      [{ id: 'source', summary: 'Original conversation', lastModified: 1 }],
      grouped,
    ).keys(),
  ]).toEqual(['source']);
  expect(raw.map((a) => a.sessionId)).toEqual(['peer-working', 'peer-approval']);
});

it('does not group standalone/unproven activity or copy a participant model to the source', () => {
  const peer = { ...activity('peer', 'working', 20), model: 'peer-model' };
  const independent = {
    ...activity('independent', 'working', 30),
    presentationConversation: undefined,
  };
  expect(conversationActivities([peer, independent])).toEqual([
    expect.objectContaining({ sessionId: 'source', model: undefined }),
    independent,
  ]);
});
