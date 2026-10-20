import { useEffect, useRef, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosSourcePacket } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
const api = new TelosWorkApiClient(apiFetch);
export interface TelosCreatedItem {
  itemId: string;
  snapshotId: string;
  packet: TelosSourcePacket;
}
/** Discover each retained creation through its canonical origin association.
 * These reads supply navigation evidence, never source/adoption authority. */
export function useTelosCreatedItems(conversationId?: string) {
  const [generation, setGeneration] = useState(0);
  const active = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ key: string; items: TelosCreatedItem[] }>();
  const key = JSON.stringify([conversationId, generation]);
  useEffect(() => {
    const refresh = () => {
      active.current?.abort();
      setGeneration((value) => value + 1);
    };
    const resume = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const off = eventBus.on('todo_update', refresh);
    const offConnection = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      offConnection();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    active.current = controller;
    void (async () => {
      const links = await api.links({ namespace: 'mitzo', conversationId }, controller.signal);
      const ids = [
        ...new Set(
          links
            .filter(
              (link) =>
                link.role === 'origin' &&
                link.conversation.namespace === 'mitzo' &&
                link.conversation.conversationId === conversationId,
            )
            .map((link) => link.itemId),
        ),
      ];
      const items: TelosCreatedItem[] = [];
      let cursor = 0;
      async function read() {
        while (cursor < ids.length && !controller.signal.aborted) {
          const itemId = ids[cursor++];
          try {
            const work = await api.read(itemId, controller.signal);
            if (work.itemId !== itemId || controller.signal.aborted) continue;
            for (const snapshot of work.sources) {
              if (
                snapshot.itemId !== itemId ||
                snapshot.selection.kind !== 'selected' ||
                snapshot.source?.namespace !== 'mitzo' ||
                snapshot.source.conversationId !== conversationId
              )
                continue;
              try {
                // The existing readSource owner verifies the immutable packet,
                // artifact hash and actual creation-to-item binding, including
                // packets whose pre-creation itemId was originally null.
                const view = await api.readSource(itemId, snapshot.snapshotId, controller.signal);
                if (
                  !controller.signal.aborted &&
                  view.available &&
                  view.snapshot.itemId === itemId &&
                  view.snapshot.snapshotId === snapshot.snapshotId &&
                  view.snapshot.source?.namespace === 'mitzo' &&
                  view.snapshot.source.conversationId === conversationId &&
                  view.packet.context.sourceConversationId === conversationId &&
                  view.packet.creation &&
                  (view.packet.itemId === null || view.packet.itemId === itemId)
                ) {
                  items.push({ itemId, snapshotId: snapshot.snapshotId, packet: view.packet });
                }
              } catch {
                /* Unavailable proof cannot supply a creation backlink. */
              }
            }
          } catch {
            /* Other independently authorized origins may still resolve. */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, read));
      if (!controller.signal.aborted)
        setResult({
          key,
          items: items.sort(
            (a, b) => a.itemId.localeCompare(b.itemId) || a.snapshotId.localeCompare(b.snapshotId),
          ),
        });
    })().catch(() => {
      if (!controller.signal.aborted) setResult({ key, items: [] });
    });
    return () => controller.abort();
  }, [conversationId, key]);
  return result?.key === key ? result.items : [];
}
