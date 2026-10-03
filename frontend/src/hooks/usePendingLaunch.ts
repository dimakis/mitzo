import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';

/** Shared launch state survives navigation until delivery is acknowledged or dismissed. */
export function usePendingLaunch() {
  const launch = useMitzoStore((s) => s.pendingSession);
  const launchSending = useMitzoStore((s) => s.pendingSessionSending);
  const dismissLaunch = useMitzoStore((s) => s.clearPendingSession);
  const sendLaunch = useMitzoStore((s) => s.sendPendingSession);
  const storeSend = useMitzoStore((s) => s.sendMessage);
  function sendMessage(text: string, opts?: SendMessageOptions): boolean {
    storeSend(text, opts);
    return true;
  }
  return { launch, launchSending, dismissLaunch, sendMessage, sendLaunch };
}
