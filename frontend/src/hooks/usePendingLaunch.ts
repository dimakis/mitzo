import { useEffect, useRef, useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';
import { consumeChatDraft, deleteChatDraft, getChatDraft } from '../lib/chat-drafts';
import {
  briefingRegistrationCapacityAvailable,
  registerBriefing,
  useBriefingRegistration,
} from '../lib/briefing-registration';

/** Launch chrome belongs to the explicitly opened saved draft. */
export function usePendingLaunch(requestedDraftId?: string | null) {
  const pending = useMitzoStore((s) => s.pendingSession);
  const sessionId = useMitzoStore((s) => s.sessions.active);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending);
  const clearLaunch = useMitzoStore((s) => s.clearPendingSession);
  const stage = useMitzoStore((s) => s.setPendingSession);
  const newSession = useMitzoStore((s) => s.newSession);
  const saved = requestedDraftId ? getChatDraft(requestedDraftId) : null;
  const restoredRequest = useRef<string | null | undefined>(undefined);
  const restoring = saved?.settings.launch && restoredRequest.current !== requestedDraftId;
  const launch =
    pending && (!pending.draftId || pending.draftId === requestedDraftId)
      ? pending
      : restoring
        ? { ...saved.settings.launch!, draftId: saved.id }
        : null;
  useEffect(() => {
    restoredRequest.current = requestedDraftId;
    if (saved?.settings.launch && pending?.draftId !== requestedDraftId) {
      newSession();
      stage({ ...saved.settings.launch, draftId: saved.id });
    } else if (pending?.draftId && pending.draftId !== requestedDraftId && !sessionId)
      clearLaunch();
    // Restore once per explicit draft navigation. Dismissal/acceptance must not reopen it.
  }, [requestedDraftId]); // eslint-disable-line react-hooks/exhaustive-deps
  function dismissLaunch() {
    if (launch?.draftId && !deleteChatDraft(launch.draftId)) return;
    clearLaunch();
  }
  const storeSendLaunch = useMitzoStore((s) => s.sendPendingSession);
  const registration = useBriefingRegistration(sessionId);
  const [capacityError, setCapacityError] = useState<{
    launch: typeof launch;
    message: string;
  } | null>(null);
  function sendLaunch(opts?: SendMessageOptions): boolean {
    const reviewed = launch;
    const submitted = reviewed?.draftId ? getChatDraft(reviewed.draftId) : null;
    if (reviewed?.briefing && !briefingRegistrationCapacityAvailable()) {
      setCapacityError({
        launch: reviewed,
        message: 'Save the existing briefing links before starting another minion conversation.',
      });
      return false;
    }
    if (!reviewed) return false;
    return storeSendLaunch({
      ...opts,
      onDelivery(status) {
        if (status === 'accepted' && submitted) consumeChatDraft(submitted);
        opts?.onDelivery?.(status);
      },
      onSessionAssigned(sessionId) {
        if (reviewed?.briefing && reviewed.accountSelection)
          void registerBriefing(
            {
              date: reviewed.briefing.date,
              revision: reviewed.briefing.revision,
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
