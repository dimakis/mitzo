/** Settings edit the next message only; running is not a lock on an existing chat. */
export function chatModelSettings(state: {
  activeSessionId: string | null;
  sessionId?: string;
  roleSetupLocked: boolean;
  localBound: boolean;
  metadataPending: boolean;
  metadataUnavailable: boolean;
  commandAvailable: boolean;
  preparedFirst: boolean;
  runtimeReason?: string;
  repositoryLoading: boolean;
  briefingLocked: boolean;
  briefingLoading: boolean;
  briefingError?: string;
  briefingLaunchReason?: string;
  launchSending: boolean;
  starting?: boolean;
  nativeConstraintReason?: string;
}) {
  const disabledReason =
    state.sessionId && state.sessionId !== state.activeSessionId
      ? 'Loading the selected chat. Wait for its settings before making changes.'
      : state.roleSetupLocked
        ? 'Finishing agent setup. Settings become available when setup completes.'
        : state.metadataUnavailable
          ? 'Conversation settings could not be loaded. Retry to continue.'
          : state.metadataPending
            ? 'Loading conversation settings…'
            : state.preparedFirst
              ? 'The prepared first message has fixed settings. Send it before changing settings for later messages.'
              : state.localBound && !state.commandAvailable
                ? (state.runtimeReason ??
                  'This chat does not support another message. Start a new chat to choose different settings.')
                : state.repositoryLoading
                  ? 'Loading repository preparation. Wait for it to finish before changing settings.'
                  : state.briefingLocked
                    ? (state.briefingError ??
                      (state.briefingLoading
                        ? 'Checking whether this chat has fixed briefing settings…'
                        : 'This briefing uses its reviewed settings. Use Change account or model to review a different selection.'))
                    : state.briefingLaunchReason
                      ? state.briefingLaunchReason
                      : state.launchSending || state.starting
                        ? 'The first message is being sent. Settings become available after the chat starts.'
                        : undefined;
  return {
    disabledReason,
    notice:
      !disabledReason && state.activeSessionId
        ? (state.nativeConstraintReason ??
          'Changes apply to your next message. Running and already queued messages keep their settings.')
        : undefined,
  };
}
