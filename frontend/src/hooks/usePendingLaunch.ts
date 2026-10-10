import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';
import { registerBriefing, useBriefingRegistration } from '../lib/briefing-registration';

/** Shared launch state survives navigation until delivery is acknowledged or dismissed. */
export function usePendingLaunch() {
  const launch = useMitzoStore((s) => s.pendingSession);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending);
  const dismissLaunch = useMitzoStore((s) => s.clearPendingSession);
  const storeSendLaunch = useMitzoStore((s) => s.sendPendingSession);
  const sessionId = useMitzoStore((s) => s.sessions.active);
  const registration = useBriefingRegistration(sessionId);
  function sendLaunch(opts?: SendMessageOptions): boolean {
    const reviewed = launch;
    return storeSendLaunch({
      ...opts,
      onSessionAssigned(sessionId) {
        if (reviewed?.briefing && reviewed.accountSelection)
          void registerBriefing(
            {
              ...reviewed.briefing,
              sessionId,
              accountId: reviewed.accountSelection.accountId,
              model: reviewed.accountSelection.model,
            },
            reviewed.accountSelection.reasoningEffort,
          );
        opts?.onSessionAssigned?.(sessionId);
      },
    });
  }
  const storeSend = useMitzoStore((s) => s.sendMessage);
  function sendMessage(text: string, opts?: SendMessageOptions): boolean {
    storeSend(text, opts);
    return true;
  }
  return {
    launch,
    launchSending,
    dismissLaunch,
    sendMessage,
    sendLaunch,
    registrationError: registration.error,
    registrationSaving: registration.saving,
    retryRegistration: registration.retry,
  };
}
