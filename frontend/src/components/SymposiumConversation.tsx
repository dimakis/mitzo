import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  FinishedMessage,
  StreamingMessage,
  SymposiumConfig,
  SymposiumProvenance,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { ChatArea, type ChatAreaProps, type SymposiumContextItem } from './ChatArea';
import { SymposiumAudienceComposer } from './SymposiumAudienceComposer';
import { SymposiumPerspectiveTabs } from './SymposiumPerspectiveTabs';
import { SymposiumProfileProposals, type SeatProfileSeed } from './SymposiumProfileProposals';

type Authored = {
  kind: 'authored';
  eventSeq: number;
  messageId: string;
  seatId: string | null;
  content: string;
  provenance: SymposiumProvenance | null;
};
type RecipientInput = SymposiumContextItem & { kind: 'recipient-input'; recipientStatus: string };
type PerspectiveItem = Authored | RecipientInput;
type QueuedInput = {
  deliveryId: string;
  recipientSeatId: string;
  proposedContent: string;
  deliveryStatus: string;
};
type PerspectivePage = { items: PerspectiveItem[]; nextSeq: number | null; queued: QueuedInput[] };
type Status = {
  sessionId: string;
  config: SymposiumConfig | null;
  seats: { seatId: string; seat: Omit<SeatProfileSeed, 'seatId'>; admitted: boolean }[];
};

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function richMessages(items: PerspectiveItem[], existing: FinishedMessage[]): FinishedMessage[] {
  const identity = (messageId: string, seatId: string | null, generation: number | null) =>
    JSON.stringify([seatId, generation, messageId]);
  const byIdentity = new Map(
    existing.map((message) => [
      identity(
        message.messageId,
        message.symposiumProvenance?.seatId ?? null,
        message.symposiumProvenance?.membershipGeneration ?? null,
      ),
      message,
    ]),
  );
  return items.flatMap((item) => {
    if (item.kind !== 'authored') return [];
    const rich = byIdentity.get(
      identity(item.messageId, item.seatId, item.provenance?.membershipGeneration ?? null),
    );
    if (rich) return [rich];
    return [
      {
        messageId: item.messageId,
        role: item.seatId ? ('assistant' as const) : ('user' as const),
        startedSeq: item.eventSeq,
        blocks: [
          { blockId: `text:${item.messageId}`, blockType: 'text' as const, content: item.content },
        ],
        ...(item.provenance ? { symposiumProvenance: item.provenance } : {}),
      },
    ];
  });
}

function liveForSeat(seatId: string, chat: ChatAreaProps): Record<string, StreamingMessage> {
  const live = { ...chat.currentByMessage };
  if (chat.current) live[chat.current.messageId] = chat.current;
  return Object.fromEntries(
    Object.entries(live).filter(([, stream]) => stream.symposiumProvenance?.seatId === seatId),
  );
}

export function SymposiumConversation({
  sessionId,
  chat,
  ordinaryComposer,
}: {
  sessionId: string | null;
  chat: ChatAreaProps;
  ordinaryComposer: ReactNode;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState('all');
  const [page, setPage] = useState<PerspectivePage>({ items: [], nextSeq: null, queued: [] });
  const [pageFor, setPageFor] = useState('');
  const [error, setError] = useState('');
  const [share, setShare] = useState<Authored | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const [shareRecipients, setShareRecipients] = useState<string[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [seatSeed, setSeatSeed] = useState<SeatProfileSeed | null>(null);
  const retryKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const base = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/symposium` : '';
  const configRevision = status?.config?.revision;

  useEffect(() => {
    setStatus(null);
    setPageFor('');
    setError('');
    setSelected('all');
    setSeatSeed(null);
    setPage({ items: [], nextSeq: null, queued: [] });
    if (!base) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await readJson<Status>(base);
        if (next.sessionId !== sessionId || !Array.isArray(next.seats) || !('config' in next))
          throw new Error('Symposium status is incomplete');
        if (!cancelled) setStatus(next);
      } catch (cause) {
        if (!cancelled) {
          setStatus(null);
          setError(cause instanceof Error ? cause.message : 'Could not load Symposium');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, sessionId]);

  useEffect(() => {
    if (configRevision === undefined || !base) return;
    let cancelled = false;
    const requestedFor = `${base}:${selected}`;
    setPageFor('');
    const refresh = async () => {
      try {
        const params = new URLSearchParams({
          kind: selected === 'all' ? 'all' : 'seat',
          limit: '200',
        });
        if (selected !== 'all') params.set('seatId', selected);
        const all: PerspectiveItem[] = [];
        let nextSeq: number | null = 0;
        let queued: QueuedInput[] = [];
        for (let n = 0; n < 10 && nextSeq !== null; n++) {
          params.set('afterSeq', String(nextSeq));
          const result = await readJson<PerspectivePage>(`${base}/perspectives?${params}`);
          if (
            !Array.isArray(result.items) ||
            !Array.isArray(result.queued) ||
            (result.nextSeq !== null &&
              (!Number.isSafeInteger(result.nextSeq) || result.nextSeq <= nextSeq))
          )
            throw new Error('Symposium perspective is incomplete');
          all.push(...result.items);
          queued = result.queued;
          nextSeq = result.nextSeq;
        }
        if (!cancelled) {
          setPage({ items: all, queued, nextSeq });
          setPageFor(requestedFor);
          setError('');
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Perspective needs recovery');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, selected, configRevision]);

  const seats = useMemo(
    () => status?.seats?.map(({ seatId, seat }) => ({ id: seatId, name: seat.name })) ?? [],
    [status],
  );
  const admitted = useMemo(
    () => status?.seats?.filter((seat) => seat.admitted).map((seat) => seat.seatId) ?? [],
    [status],
  );
  const recipients =
    selected === 'all' ? admitted : admitted.filter((seatId) => seatId === selected);
  const seatName = seats.find((seat) => seat.id === selected)?.name ?? selected;
  const visiblePage =
    pageFor === `${base}:${selected}` ? page : { items: [], queued: [], nextSeq: null };
  const items =
    selected === 'all'
      ? visiblePage.items
      : visiblePage.items.filter((item) =>
          item.kind === 'authored' ? item.seatId === selected : item.recipientSeatId === selected,
        );
  const contextItems = items.filter(
    (item): item is RecipientInput => item.kind === 'recipient-input',
  );
  const shownMessages = selected === 'all' ? chat.messages : richMessages(items, chat.messages);
  const live = selected === 'all' ? chat.currentByMessage : liveForSeat(selected, chat);
  const current = selected === 'all' ? chat.current : null;
  const queue = useCallback(
    async (recipientSeatIds: string[], content: string) => {
      const fingerprint = JSON.stringify({ recipientSeatIds, content });
      if (retryKey.current?.fingerprint !== fingerprint)
        retryKey.current = { fingerprint, key: crypto.randomUUID() };
      await readJson(`${base}/deliveries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceSeatId: null,
          recipientSeatIds,
          originalContent: content,
          idempotencyKey: retryKey.current.key,
        }),
      });
      retryKey.current = null;
      return true;
    },
    [base],
  );
  const submitShare = useCallback(async () => {
    if (
      !share ||
      !excerpt.trim() ||
      !share.content.includes(excerpt.trim()) ||
      shareRecipients.length === 0
    )
      return;
    setShareBusy(true);
    try {
      await readJson(`${base}/share-excerpt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceMessageId: share.messageId,
          sourceSeatId: share.seatId,
          ...(share.provenance?.membershipGeneration !== undefined
            ? { sourceMembershipGeneration: share.provenance.membershipGeneration }
            : {}),
          excerpt: excerpt.trim(),
          recipientSeatIds: shareRecipients,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setShare(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not share excerpt');
    } finally {
      setShareBusy(false);
    }
  }, [base, share, excerpt, shareRecipients]);
  const startShare = useCallback(
    (messageId: string, provenance?: SymposiumProvenance) => {
      const matches = items.filter(
        (candidate): candidate is Authored =>
          candidate.kind === 'authored' &&
          candidate.messageId === messageId &&
          candidate.seatId === selected &&
          (candidate.provenance?.membershipGeneration ?? null) ===
            (provenance?.membershipGeneration ?? null),
      );
      if (matches.length !== 1) return;
      const item = matches[0];
      setShare(item);
      setExcerpt(item.content);
      setShareRecipients([]);
    },
    [items, selected],
  );

  if (base && (!status || status.sessionId !== sessionId))
    return (
      <>
        <ChatArea {...chat} />
        {error ? <div role="alert">{error}</div> : <div role="status">Loading Symposium…</div>}
      </>
    );
  if (!status?.config)
    return (
      <>
        {chat && <ChatArea {...chat} />}
        {sessionId && <SymposiumProfileProposals key={sessionId} sessionId={sessionId} />}
        {ordinaryComposer}
      </>
    );
  return (
    <SymposiumPerspectiveTabs
      seats={seats}
      selected={selected}
      onSelect={(next) => {
        setSelected(next);
        setShare(null);
      }}
    >
      <p className="symposium-boundary-note">
        Seats share this session's admitted context and provider access. An aside goes only to its
        named recipients.
      </p>
      {selected !== 'all' && status.seats.find((seat) => seat.seatId === selected) && (
        <button
          type="button"
          onClick={() =>
            setSeatSeed({
              seatId: selected,
              ...status.seats.find((seat) => seat.seatId === selected)!.seat,
            })
          }
        >
          Draft reusable profile from this seat
        </button>
      )}
      {sessionId && (
        <SymposiumProfileProposals
          key={sessionId}
          sessionId={sessionId}
          seatSeed={seatSeed}
          onSeatSeedDone={() => setSeatSeed(null)}
        />
      )}
      {error && <div role="alert">{error}</div>}
      {visiblePage.nextSeq !== null && (
        <div role="status">Showing the first 2,000 durable events. More history is available.</div>
      )}
      <ChatArea
        {...chat}
        messages={shownMessages}
        current={current}
        currentByMessage={live}
        contextItems={contextItems}
        onShareMessage={selected === 'all' ? undefined : startShare}
        running={chat.running && (selected === 'all' || Object.keys(live ?? {}).length > 0)}
      />
      {visiblePage.queued.filter((item) => selected === 'all' || item.recipientSeatId === selected)
        .length > 0 && (
        <aside className="symposium-queued-inputs" aria-label="Queued inputs">
          <strong>Queued for review</strong>
          {visiblePage.queued
            .filter((item) => selected === 'all' || item.recipientSeatId === selected)
            .map((item) => (
              <p key={`${item.deliveryId}:${item.recipientSeatId}`}>
                {item.recipientSeatId}: {item.proposedContent} ({item.deliveryStatus})
              </p>
            ))}
        </aside>
      )}
      {share && (
        <section className="symposium-share-preview" aria-label="Share excerpt preview">
          <strong>Share only this excerpt from {seatName}</strong>
          <textarea
            aria-label="Excerpt to share"
            value={excerpt}
            onChange={(event) => setExcerpt(event.target.value)}
          />
          {seats
            .filter((seat) => seat.id !== share.seatId && admitted.includes(seat.id))
            .map((seat) => (
              <label key={seat.id}>
                <input
                  type="checkbox"
                  checked={shareRecipients.includes(seat.id)}
                  onChange={(event) =>
                    setShareRecipients((old) =>
                      event.target.checked ? [...old, seat.id] : old.filter((id) => id !== seat.id),
                    )
                  }
                />
                {seat.name}
              </label>
            ))}
          <p>Preview: {excerpt}</p>
          <button
            type="button"
            disabled={
              shareBusy ||
              !excerpt.trim() ||
              !share.content.includes(excerpt.trim()) ||
              shareRecipients.length === 0
            }
            onClick={() => void submitShare()}
          >
            Queue excerpt for approval
          </button>
          <button type="button" onClick={() => setShare(null)}>
            Cancel
          </button>
        </section>
      )}
      <SymposiumAudienceComposer
        audience={selected}
        audienceLabel={selected === 'all' ? 'all admitted seats' : seatName}
        recipients={recipients}
        enabled={recipients.length > 0}
        onQueue={queue}
      />
    </SymposiumPerspectiveTabs>
  );
}
