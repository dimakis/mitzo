import { useEffect, useState } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';

/** Keep incoming launches as reviewable drafts until the user sends. */
export function usePendingLaunch() {
  const pending = useMitzoStore((s) => s.pendingSession);
  const clearPending = useMitzoStore((s) => s.clearPendingSession);
  const [launch, setLaunch] = useState<typeof pending>(null);
  useEffect(() => {
    if (!pending) return;
    setLaunch(pending);
    clearPending();
  }, [pending, clearPending]);
  return { launch, dismissLaunch: () => setLaunch(null) };
}
