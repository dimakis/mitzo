import { useEffect, useState, type ReactNode } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosSourcePacket } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';

import { SourceContext, type SourceRequest } from './useTelosSourceNavigation';
const api = new TelosWorkApiClient(apiFetch);

/** Source URLs restore the real chat. Retained evidence selects its boundary;
 * it never substitutes a transcript, changes settings, or selects a worker. */
export function TelosSourceNavigationProvider({
  request,
  sessionId,
  children,
}: {
  request?: SourceRequest;
  sessionId: string | null;
  children: ReactNode;
}) {
  const key = request ? JSON.stringify(request) : '';
  const [result, setResult] = useState<{ key: string; packet?: TelosSourcePacket } | null>(null);
  useEffect(() => {
    if (!request || request.conversationId !== sessionId) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => api.readSource(request.itemId, request.snapshotId, controller.signal))
      .then(
        (view) => {
          if (controller.signal.aborted) return;
          const valid =
            view.available &&
            view.snapshot.itemId === request.itemId &&
            view.snapshot.snapshotId === request.snapshotId &&
            view.snapshot.source?.namespace === 'mitzo' &&
            view.packet.context.sourceConversationId === request.conversationId &&
            view.snapshot.source?.conversationId === request.conversationId;
          setResult({ key, packet: valid ? view.packet : undefined });
        },
        () => {
          if (!controller.signal.aborted) setResult({ key });
        },
      );
    return () => controller.abort();
    // The serialized selector fences requests even when the caller recreates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sessionId]);
  const current =
    request && request.conversationId === sessionId
      ? {
          ...request,
          status:
            result?.key !== key
              ? ('loading' as const)
              : result.packet
                ? ('ready' as const)
                : ('unavailable' as const),
          packet: result?.key === key ? result.packet : undefined,
        }
      : null;
  return <SourceContext.Provider value={current}>{children}</SourceContext.Provider>;
}
