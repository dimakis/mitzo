import { useEffect, useState } from 'react';
import { z } from 'zod';
import { SessionRuntimeBindingSchema, type TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { useSessionList } from './useSessionList';
import { telosChatRows } from '../lib/telos-chat-rows';
import type { TelosChatDetails } from '../components/TelosChatList';
const Metadata = z.object({
  sessionId: z.string(),
  createdAt: z.number().int().nonnegative().max(8640000000000000).optional().catch(undefined),
  accountBinding: z
    .object({ accountLabel: z.string().nullish(), model: z.string().nullish() })
    .nullish(),
  modelSelection: z
    .object({
      model: z.string(),
      models: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    })
    .nullish(),
  agentProfile: z.object({ definition: z.object({ name: z.string() }) }).nullish(),
  runtimeBinding: SessionRuntimeBindingSchema.nullish(),
});
/** Read-only display from the existing catalog and exact session metadata. */
export function useTelosChatDetails(work: TelosWorkView | undefined) {
  const catalog = useSessionList();
  const [result, setResult] = useState<{ work: TelosWorkView; details: TelosChatDetails }>();
  useEffect(() => {
    if (!work) return;
    const controller = new AbortController(),
      details: TelosChatDetails = {};
    const queue = telosChatRows(work).filter((row) => row.conversation.namespace === 'mitzo');
    let cursor = 0;
    async function read() {
      while (cursor < queue.length && !controller.signal.aborted) {
        const row = queue[cursor++];
        try {
          const response = await apiFetch(
            `/api/sessions/${encodeURIComponent(row.conversation.conversationId)}/meta`,
            { signal: controller.signal },
          );
          if (!response.ok) throw Error('Metadata unavailable');
          const meta = Metadata.parse(await response.json());
          if (meta.sessionId !== row.conversation.conversationId)
            throw Error('Metadata identity changed');
          const model = meta.modelSelection?.model ?? meta.accountBinding?.model;
          const modelLabel =
            meta.modelSelection?.models?.find((value) => value.id === model)?.label ?? model;
          const location = meta.runtimeBinding?.execution.location;
          details[row.key] = {
            accountModel: [meta.accountBinding?.accountLabel, modelLabel]
              .filter(Boolean)
              .join(' · '),
            profileTarget: [
              meta.agentProfile?.definition.name,
              location === 'local'
                ? 'Local Mac'
                : location === 'openshell'
                  ? 'OpenShell'
                  : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
            createdAt: meta.createdAt,
            ...(!meta.agentProfile?.definition.name &&
            !meta.accountBinding?.accountLabel &&
            !modelLabel &&
            !location
              ? { description: 'Settings unavailable' }
              : {}),
          };
        } catch {
          details[row.key] = { description: 'Settings unavailable' };
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, read)).then(() => {
      if (!controller.signal.aborted) setResult({ work, details });
    });
    return () => controller.abort();
  }, [work]);
  const details: TelosChatDetails = result && result.work === work ? { ...result.details } : {};
  if (work)
    for (const row of telosChatRows(work)) {
      if (row.conversation.namespace !== 'mitzo') continue;
      const title = catalog.sessions.find(
        (session) => session.id === row.conversation.conversationId,
      )?.summary;
      if (title) details[row.key] = { ...details[row.key], title };
    }
  return details;
}
