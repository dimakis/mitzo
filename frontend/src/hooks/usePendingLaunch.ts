import { useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';
import {
  briefingRegistrationCapacityAvailable,
  registerBriefing,
  useBriefingRegistration,
} from '../lib/briefing-registration';

/** Shared launch state survives navigation until delivery is acknowledged or dismissed. */
export function usePendingLaunch() {
  const launch = useMitzoStore((s) => s.pendingSession);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending);
  const dismissLaunch = useMitzoStore((s) => s.clearPendingSession);
  const storeSendLaunch = useMitzoStore((s) => s.sendPendingSession);
  const sessionId = useMitzoStore((s) => s.sessions.active);
  const registration = useBriefingRegistration(sessionId);
  const [capacityError, setCapacityError] = useState<{
    launch: typeof launch;
    message: string;
  } | null>(null);
  function sendLaunch(opts?: SendMessageOptions): boolean {
    const reviewed = launch;
    if (reviewed?.briefing && !briefingRegistrationCapacityAvailable()) {
      setCapacityError({
        launch: reviewed,
        message: 'Save the existing briefing links before starting another minion conversation.',
      });
      return false;
    }
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
    registrationError:
      registration.error || (capacityError?.launch === launch ? capacityError.message : ''),
    registrationSaving: registration.saving,
    retryRegistration: registration.retry,
  };
}
