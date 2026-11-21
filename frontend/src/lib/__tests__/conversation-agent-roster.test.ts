import { expect, it } from 'vitest';
import { projectConversationAgents } from '../conversation-agent-roster';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';

it('keeps known configuration and roster order independent of activity and membership availability', () => {
  const view = sharedConversationView();
  const first = projectConversationAgents({
    view,
    names: { reviewer: 'Reviewer' },
    connected: true,
  });
  expect(first[1]).toMatchObject({
    name: 'Reviewer',
    model: 'offline-fixture',
    profile: 'default · revision 1',
    mode: 'agent',
    membership: 'Member',
    state: 'Not observed',
  });
  view.participantSessionIds.reverse();
  view.messages = [];
  view.unavailableParticipantSessionIds = ['reviewer'];
  const next = projectConversationAgents({ view, previous: first, names: {}, connected: false });
  expect(next.map((a) => a.id)).toEqual(first.map((a) => a.id));
  expect(next[1]).toMatchObject({
    name: 'Reviewer',
    model: 'offline-fixture',
    profile: 'default · revision 1',
    mode: 'agent',
    membership: 'Member · unavailable',
    state: 'Not observed',
  });
  expect(next[1].diagnostic).toMatch(/Refresh/);
  expect(next[1].policy).toBeUndefined();
});

it('uses the latest recorded settings, including earlier history, and never resurrects removed membership', () => {
  const view = sharedConversationView();
  const earlierMessages = structuredClone(view.messages);
  const settings = view.messages[0].settings.reviewer;
  view.messages = [
    {
      ...view.messages[0],
      sequence: 10,
      settings: {
        reviewer: {
          ...settings,
          selection: {
            ...settings.selection,
            model: 'new-model',
            permission: { mode: 'ask', revision: 1 },
          },
        },
      },
    },
  ];
  const agents = projectConversationAgents({ view, earlierMessages, names: {}, connected: true });
  expect(agents[0].model).toBe('offline-fixture');
  expect(agents[1]).toMatchObject({ model: 'new-model', mode: 'ask' });
  view.participantSessionIds = ['architect'];
  expect(
    projectConversationAgents({ view, previous: agents, names: {}, connected: true }).map(
      (a) => a.id,
    ),
  ).toEqual(['architect']);
});
