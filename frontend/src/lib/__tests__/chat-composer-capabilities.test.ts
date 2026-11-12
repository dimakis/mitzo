import { expect, it } from 'vitest';
import { chatComposerCapabilities } from '../chat-composer-capabilities';

it('opens the host terminal before a chat exists and retains the draft return route', () => {
  expect(
    chatComposerCapabilities({
      ordinary: true,
      location: 'local',
      draftId: 'draft-a',
      blocked: false,
    }),
  ).toEqual({ terminalHref: '/terminal?returnTo=%2Fchat%3Fdraft%3Ddraft-a', commands: 'ordinary' });
});
it('keeps ordinary host chat actions available after first-command admission', () => {
  expect(
    chatComposerCapabilities({
      ordinary: true,
      location: 'local',
      sessionId: 'chat-a',
      blocked: false,
    }),
  ).toEqual({
    terminalHref: '/terminal?sessionId=chat-a&returnTo=%2Fchat%2Fchat-a',
    commands: 'ordinary',
  });
});
it('never maps a new sandbox chat to the host and keeps metadata-loading controls blocked', () => {
  expect(
    chatComposerCapabilities({ ordinary: true, location: 'openshell', blocked: false }),
  ).toEqual({ commands: 'unavailable' });
  expect(chatComposerCapabilities({ ordinary: true, location: 'local', blocked: true })).toEqual({
    commands: 'unavailable',
  });
});
it('uses the original session destination for an existing sandbox chat', () => {
  expect(
    chatComposerCapabilities({
      ordinary: true,
      location: 'openshell',
      sessionId: 'remote',
      blocked: false,
    }),
  ).toEqual({
    terminalHref: '/terminal?sessionId=remote&returnTo=%2Fchat%2Fremote',
    commands: 'unavailable',
  });
});
