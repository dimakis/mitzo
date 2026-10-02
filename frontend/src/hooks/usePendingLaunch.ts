import { useEffect, useRef, useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { SendMessageOptions } from '@mitzo/client';

/** Keep incoming launches until their matching delivery is acknowledged. */
export function usePendingLaunch() {
  const pending = useMitzoStore((s) => s.pendingSession);
  const clearPending = useMitzoStore((s) => s.clearPendingSession);
  const storeSend = useMitzoStore((s) => s.sendMessage);
  const dispatch = useMitzoStore((s) => s.dispatchMessages);
  const [launch, setLaunch] = useState<typeof pending>(null);
  const [launchSending, setLaunchSending] = useState(false);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!pending) return;
    attempt.current++;
    inFlight.current = false;
    setLaunchSending(false);
    setLaunch(pending);
    clearPending();
  }, [pending, clearPending]);
  function dismissLaunch() {
    attempt.current++;
    inFlight.current = false;
    setLaunchSending(false);
    setLaunch(null);
  }
  function sendMessage(text: string, opts?: SendMessageOptions): boolean {
    if (!launch) {
      storeSend(text, opts);
      return true;
    }
    if (inFlight.current) return false;
    const currentAttempt = ++attempt.current;
    inFlight.current = true;
    setLaunchSending(true);
    dispatch({ type: 'SET_SESSION_CONTEXT', context: launch.context });
    let queued = true;
    storeSend(text, {
      ...opts,
      ...(launch.telosTaskId ? { telosTaskId: launch.telosTaskId } : {}),
      ...(launch.agentName ? { agentName: launch.agentName } : {}),
      onDelivery(status) {
        if (attempt.current !== currentAttempt) return;
        if (status === 'accepted') dismissLaunch();
        else if (status === 'failed') {
          queued = false;
          inFlight.current = false;
          setLaunchSending(false);
        }
        // Uncertain delivery retains the preview and prevents a duplicate send.
      },
    });
    return queued;
  }
  return { launch, launchSending, dismissLaunch, sendMessage };
}
