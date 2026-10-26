import { describe, expect, it } from 'vitest';
import { chatModelSettings } from '../chat-model-settings';

const ready = {
  activeSessionId: 'chat',
  sessionId: 'chat',
  roleSetupLocked: false,
  localBound: false,
  metadataPending: false,
  metadataUnavailable: false,
  commandAvailable: false,
  preparedFirst: false,
  repositoryLoading: false,
  briefingLocked: false,
  briefingLoading: false,
  launchSending: false,
};
describe('chat model settings availability', () => {
  it('retains native model restrictions instead of promising unsupported changes', () => {
    expect(
      chatModelSettings({
        ...ready,
        nativeConstraintReason: 'This native conversation keeps its original model and thinking.',
      }).notice,
    ).toBe('This native conversation keeps its original model and thinking.');
  });
  it('allows next-message settings for existing legacy and runtime chats', () => {
    expect(chatModelSettings(ready).disabledReason).toBeUndefined();
    expect(
      chatModelSettings({ ...ready, localBound: true, commandAvailable: true }).notice,
    ).toMatch(/next message/);
  });
  it('distinguishes unsent legacy queue choices from already submitted runtime commands', () => {
    expect(chatModelSettings(ready).notice).toBe(
      'The running response keeps its settings. Queued messages use your current choices when sent.',
    );
    expect(chatModelSettings({ ...ready, localBound: true, commandAvailable: true }).notice).toBe(
      'Changes apply to your next message. Running and already queued messages keep their settings.',
    );
  });
  it.each([
    [{ metadataPending: true }, /Loading conversation settings/],
    [{ metadataPending: true, metadataUnavailable: true }, /could not be loaded/],
    [{ localBound: true }, /does not support another message/],
    [{ preparedFirst: true }, /first message/],
    [{ repositoryLoading: true }, /repository/],
    [{ briefingLocked: true, briefingLoading: true }, /Checking/],
    [
      { briefingLocked: true, briefingError: 'Could not verify briefing. Retry lookup.' },
      /Retry lookup/,
    ],
    [{ launchSending: true }, /being sent/],
    [{ roleSetupLocked: true }, /agent setup/],
    [{ sessionId: 'other' }, /Loading the selected chat/],
  ])('explains the blocking state %j', (state, reason) => {
    expect(chatModelSettings({ ...ready, ...state }).disabledReason).toMatch(reason);
  });
});
