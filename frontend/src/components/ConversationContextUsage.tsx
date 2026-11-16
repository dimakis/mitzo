import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ModelTokenLimitsSchema } from '@mitzo/protocol';
import type { Session } from '../types/chat';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { HomeDialog } from './HomeDialog';
import { SeatLabel } from './SeatLabel';
import { SessionContextUsage } from './SessionContextUsage';
import './ConversationContextUsage.css';

const responseSchema = z.object({
  sessionId: z.string(),
  contextUsage: z
    .object({
      used: z.number().int().nonnegative().nullable(),
      measuredAt: z.number().finite(),
      limits: ModelTokenLimitsSchema.nullable(),
    })
    .nullable()
    .optional(),
});
type Row = { usage?: Session['contextUsage']; error?: string };

/** Read-only inspection of each ordinary session's own recorded measurements.
 * Membership labels grant no access: the ordinary context endpoint authorizes every read.
 */
export function ConversationContextUsage({
  participants,
}: {
  participants: { id: string; name: string; unavailable?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recorded, setRecorded] = useState<{ key: string; rows: Record<string, Row> }>();
  const key = JSON.stringify(participants.map((p) => [p.id, !!p.unavailable]));
  useEffect(() => {
    const lost = () => {
      setOpen(false);
      setRecorded(undefined);
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, lost);
  }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const rows = JSON.parse(key) as [string, boolean][];
    setRecorded({ key, rows: {} });
    void Promise.all(
      rows.map(async ([id, unavailable]) => {
        let row: Row;
        try {
          if (unavailable) throw Error('Agent unavailable. Refresh Agents before retrying.');
          const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/context`, {
            signal: controller.signal,
          });
          if (!response.ok)
            throw Error('Context could not be read. Retry when the agent is available.');
          const data = responseSchema.parse(await response.json());
          if (data.sessionId !== id)
            throw Error('Context belongs to a different agent. Refresh before retrying.');
          row = { usage: data.contextUsage ?? undefined };
        } catch (cause) {
          if (controller.signal.aborted) return;
          console.warn('Agent context inspection failed', {
            code: 'collaboration_context_read_failed',
            stage: 'inspect_context',
            sessionId: id,
            cause: cause instanceof Error ? cause.name : typeof cause,
          });
          row = { error: cause instanceof Error ? cause.message : 'Context unavailable. Retry.' };
        }
        if (!controller.signal.aborted)
          setRecorded((previous) => ({
            key,
            rows: { ...(previous?.key === key ? previous.rows : {}), [id]: row },
          }));
      }),
    );
    return () => controller.abort();
  }, [open, key, refresh]);
  return (
    <>
      <button
        type="button"
        className="token-bar conversation-context-wheel"
        aria-label="Token usage"
        title="Context usage for each agent"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="conversation-context-ring" aria-hidden="true" />
        <span className="conversation-context-count" aria-hidden="true">
          {participants.length}
        </span>
        <span className="sr-only">{participants.length} agents, each with its own context</span>
      </button>
      <HomeDialog title="Context by agent" open={open} onClose={() => setOpen(false)}>
        <p>Each agent has its own context. The wheel shows agent count, not a shared percentage.</p>
        {participants.map((p) => {
          const row = recorded?.key === key ? recorded.rows[p.id] : undefined;
          return (
            <section className="conversation-context-row" key={p.id}>
              <h3>
                <SeatLabel seatId={p.id} name={p.name} />
              </h3>
              {!row ? (
                <p role="status">Loading context…</p>
              ) : row.error ? (
                <p role="alert">{row.error}</p>
              ) : (
                <>
                  <SessionContextUsage usage={row.usage} />
                  {row.usage && (
                    <small>
                      Recorded{' '}
                      <time dateTime={new Date(row.usage.measuredAt).toISOString()}>
                        {new Date(row.usage.measuredAt).toLocaleString()}
                      </time>
                    </small>
                  )}
                </>
              )}
            </section>
          );
        })}
        <button type="button" className="home-secondary" onClick={() => setRefresh((n) => n + 1)}>
          Refresh context
        </button>
      </HomeDialog>
    </>
  );
}
