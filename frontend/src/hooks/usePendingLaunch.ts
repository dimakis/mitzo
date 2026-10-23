import {
  launchDraftSnapshot,
  subscribeLaunchDrafts,
  launchDeliveryState,
  briefingLaunchUnsupportedReason,
} from '../lib/launch-draft-delivery';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { OrdinaryRuntimeFirstCommand } from '@mitzo/protocol';
import type { SendMessageOptions } from '@mitzo/client';
import { deleteChatDraft, getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';
import {
  briefingRegistrationCapacityAvailable,
  registerBriefing,
  useBriefingRegistration,
} from '../lib/briefing-registration';

/** Launch chrome belongs to the explicitly opened saved draft. */
export function usePendingLaunch(requestedDraftId?: string | null, search = '') {
  const snapshot = useSyncExternalStore(subscribeLaunchDrafts, () =>
    launchDraftSnapshot(requestedDraftId),
  );
  const launchDeliveryPending = !!launchDeliveryState(requestedDraftId);
  const [accountError, setLaunchAccountError] = useState<{
    draftId: string;
    message: string;
  } | null>(null);
  const pending = useMitzoStore((s) => s.pendingSession);
  const sessionId = useMitzoStore((s) => s.sessions.active);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending) || launchDeliveryPending;
  const clearLaunch = useMitzoStore((s) => s.clearPendingSession);
  const stage = useMitzoStore((s) => s.setPendingSession);
  const newSession = useMitzoStore((s) => s.newSession);
  const saved = useMemo(
    () => (JSON.parse(snapshot) as { draft: ChatDraft | null }).draft,
    [snapshot],
  );
  const restoredRequest = useRef<string | null | undefined>(undefined);
  const restoring = saved?.settings.launch && restoredRequest.current !== requestedDraftId;
  const ownedLaunch = useMemo(
    () =>
      pending && (!pending.draftId || pending.draftId === requestedDraftId)
        ? pending
        : restoring
          ? { ...saved.settings.launch!, draftId: saved.id }
          : null,
    [pending, requestedDraftId, restoring, saved],
  );
  const launchAccountError =
    accountError && accountError.draftId === ownedLaunch?.draftId ? accountError.message : '';
  const selectedAccountId = saved?.settings.selection?.accountId;
  const selectedModel = saved?.settings.selection?.model;
  const selectedEffort = saved?.settings.selection?.reasoningEffort;
  const launch = useMemo(
    () =>
      ownedLaunch?.draftId && !ownedLaunch.briefing && selectedAccountId && selectedModel
        ? {
            ...ownedLaunch,
            accountSelection: {
              accountId: selectedAccountId,
              model: selectedModel,
              reasoningEffort: selectedEffort,
            },
          }
        : ownedLaunch,
    [ownedLaunch, selectedAccountId, selectedModel, selectedEffort],
  );
  const saveLaunchAccount = useCallback(
    (selection: { accountId?: string; model: string; reasoningEffort?: string | null }) => {
      if (!ownedLaunch?.draftId || ownedLaunch.briefing) return true;
      const current = getChatDraft(ownedLaunch.draftId);
      if (!current?.settings.launch || !selection.accountId || launchDeliveryState(current.id))
        return false;
      const accountSelection = { ...selection, accountId: selection.accountId };
      const ok = saveChatDraft({
        ...current,
        settings: {
          ...current.settings,
          selection: accountSelection,
          launch: { ...current.settings.launch, accountSelection },
        },
      });
      setLaunchAccountError(
        ok
          ? null
          : {
              draftId: current.id,
              message: 'Could not save the launch account. Your draft was kept.',
            },
      );
      return ok;
    },
    [ownedLaunch?.draftId, ownedLaunch?.briefing],
  );
  useEffect(() => {
    restoredRequest.current = requestedDraftId;
    if (saved?.settings.launch && (pending?.draftId !== requestedDraftId || sessionId)) {
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
    if (reviewed?.briefing && !briefingRegistrationCapacityAvailable()) {
      setCapacityError({
        launch: reviewed,
        message: 'Save the existing briefing links before starting another minion conversation.',
      });
      return false;
    }
    if (!reviewed || launchDeliveryPending) return false;
    return storeSendLaunch({
      ...opts,
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
  const sendOwned = useMitzoStore((s) => s.sendLocalFirstCommand);
  const dispatchMessages = useMitzoStore((s) => s.dispatchMessages);
  const briefingLaunchReason = launch?.briefing
    ? briefingLaunchUnsupportedReason(requestedDraftId, launch, search)
    : undefined;
  function sendBriefingCommand(
    command: OrdinaryRuntimeFirstCommand,
    opts?: SendMessageOptions & { draftId?: string },
  ): boolean {
    if (
      !launch?.briefing ||
      !launch.draftId ||
      launchSending ||
      briefingLaunchReason ||
      !briefingRegistrationCapacityAvailable()
    )
      return false;
    const sent = sendOwned(command, { ...opts, draftId: launch.draftId });
    if (sent) dispatchMessages({ type: 'SET_SESSION_CONTEXT', context: launch.context });
    return sent;
  }
  const storeSend = useMitzoStore((s) => s.sendMessage);
  function sendMessage(text: string, opts?: SendMessageOptions): boolean {
    storeSend(text, opts);
    return true;
  }
  return {
    launch,
    briefingLaunchReason,
    sendBriefingCommand,
    launchSending,
    launchDeliveryPending,
    launchAccountError,
    saveLaunchAccount,
    dismissLaunch,
    sendMessage,
    sendLaunch,
    registrationError:
      briefingLaunchReason ||
      launchAccountError ||
      registration.error ||
      (capacityError?.launch === launch ? capacityError.message : ''),
    registrationSaving: registration.saving,
    retryRegistration: registration.retry,
  };
}
