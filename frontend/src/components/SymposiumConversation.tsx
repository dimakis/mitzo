import { SeatLabel } from './SeatLabel';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  FinishedMessage,
  StreamingMessage,
  SymposiumConfig,
  SymposiumDeliveryRecord,
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
  deliveries?: SymposiumDeliveryRecord[];
  runtimeAvailable?: boolean;
  seats: {
    seatId: string;
    seat: Omit<SeatProfileSeed, 'seatId'>;
    admitted: boolean;
    membership?: { state: string } | null;
  }[];
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
  const [statusFresh, setStatusFresh] = useState(false);
  const [selected, setSelected] = useState('all');
  const [page, setPage] = useState<PerspectivePage>({ items: [], nextSeq: null, queued: [] });
  const [pageFor, setPageFor] = useState('');
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [share, setShare] = useState<Authored | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const [shareRecipients, setShareRecipients] = useState<string[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [deliveryActions, setDeliveryActions] = useState<
    Record<
      string,
      {
        approve?: boolean;
        send?: boolean;
        stop?: boolean;
        stopRequested?: boolean;
        notice: string;
        dispatchUncertain?: boolean;
        sendRequested?: boolean;
      }
    >
  >({});
  const activeActions = useRef(new Set<string>());
  const dispatchRequests = useRef(new Set<string>());
  const [seatSeed, setSeatSeed] = useState<SeatProfileSeed | null>(null);
  // Keep every uncertain request until its response is confirmed, including when
  // the operator changes audiences or revisits an excerpt.
  const retryKeys = useRef(new Map<string, string>());
  const sessionEpoch = useRef(0);
  const base = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/symposium` : '';
  const configRevision = status?.config?.revision;

  useEffect(() => {
    sessionEpoch.current += 1;
    setShare(null);
    setShareBusy(false);
    setStatus(null);
    setStatusFresh(false);
    setPageFor('');
    setError('');
    setStatusError('');
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
        if (!cancelled) {
          setStatus(next);
          setStatusFresh(true);
          setStatusError('');
        }
      } catch (cause) {
        if (!cancelled) {
          setStatus((current) => (current?.sessionId === sessionId ? current : null));
          setStatusFresh(false);
          setStatusError(cause instanceof Error ? cause.message : 'Could not load Symposium');
        }
      }
    };
    void refresh();
    const onRosterChanged = () => void refresh();
    window.addEventListener('symposium-roster-changed', onRosterChanged);
    window.addEventListener('symposium-deliveries-changed', onRosterChanged);
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('symposium-roster-changed', onRosterChanged);
      window.removeEventListener('symposium-deliveries-changed', onRosterChanged);
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
    const onDeliveriesChanged = () => void refresh();
    window.addEventListener('symposium-deliveries-changed', onDeliveriesChanged);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('symposium-deliveries-changed', onDeliveriesChanged);
    };
  }, [base, selected, configRevision]);

  const seats = useMemo(
    () =>
      status?.seats?.map(({ seatId, seat }) => ({
        id: seatId,
        name: seat.name,
        role: seat.role,
      })) ?? [],
    [status],
  );
  const admitted = useMemo(
    () => status?.seats?.filter((seat) => seat.admitted).map((seat) => seat.seatId) ?? [],
    [status],
  );
  const anchorSeatId = status?.config?.version === 2 ? status.config.anchorSeatId : undefined;
  const compact = Boolean(
    status?.config?.version === 2 &&
    status.config.state === 'active' &&
    status.seats.some((seat) => seat.seatId === anchorSeatId && seat.admitted) &&
    status.seats
      .filter((seat) => seat.seatId !== anchorSeatId)
      .every((seat) => seat.membership?.state === 'removed'),
  );
  useEffect(() => {
    if (compact) {
      setSelected('all');
      setShare(null);
    }
  }, [compact]);
  const recipients =
    compact && anchorSeatId
      ? admitted.filter((seatId) => seatId === anchorSeatId)
      : admitted.filter((seatId) => seatId === selected);
  const recipientChoices = seats.filter(
    (seat) => admitted.includes(seat.id) && (!compact || seat.id === anchorSeatId),
  );
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
    async (recipients: string[], content: string) => {
      const recipientSeatIds = [...recipients].sort();
      const fingerprint = JSON.stringify({ base, kind: 'delivery', recipientSeatIds, content });
      const key = retryKeys.current.get(fingerprint) ?? crypto.randomUUID();
      retryKeys.current.set(fingerprint, key);
      await readJson(`${base}/deliveries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceSeatId: null,
          recipientSeatIds,
          originalContent: content,
          idempotencyKey: key,
        }),
      });
      if (retryKeys.current.get(fingerprint) === key) retryKeys.current.delete(fingerprint);
      window.dispatchEvent(new Event('symposium-deliveries-changed'));
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
    const request = {
      sourceMessageId: share.messageId,
      sourceSeatId: share.seatId,
      ...(share.provenance?.membershipGeneration !== undefined
        ? { sourceMembershipGeneration: share.provenance.membershipGeneration }
        : {}),
      excerpt: excerpt.trim(),
      recipientSeatIds: [...shareRecipients].sort(),
    };
    const fingerprint = JSON.stringify({ base, kind: 'excerpt', ...request });
    const key = retryKeys.current.get(fingerprint) ?? crypto.randomUUID();
    retryKeys.current.set(fingerprint, key);
    const epoch = sessionEpoch.current;
    setShareBusy(true);
    try {
      await readJson(`${base}/share-excerpt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          idempotencyKey: key,
        }),
      });
      if (retryKeys.current.get(fingerprint) === key) retryKeys.current.delete(fingerprint);
      if (sessionEpoch.current === epoch) {
        setShare(null);
        setError('');
        window.dispatchEvent(new Event('symposium-deliveries-changed'));
      }
    } catch (cause) {
      if (sessionEpoch.current === epoch)
        setError(cause instanceof Error ? cause.message : 'Could not share excerpt');
    } finally {
      if (sessionEpoch.current === epoch) setShareBusy(false);
    }
  }, [base, share, excerpt, shareRecipients]);
  const controlDelivery = async (deliveryId: string, action: 'approve' | 'send' | 'stop') => {
    const identity = `${base}:${deliveryId}`;
    const actionIdentity = `${identity}:${action}`;
    if (activeActions.current.has(actionIdentity)) return;
    if (action === 'send' && dispatchRequests.current.has(identity)) return;
    if (action === 'send') dispatchRequests.current.add(identity);
    activeActions.current.add(actionIdentity);
    const epoch = sessionEpoch.current;
    setDeliveryActions((old) => ({
      ...old,
      [identity]: {
        ...old[identity],
        [action]: true,
        ...(action === 'send' ? { sendRequested: true } : {}),
        ...(action === 'stop' ? { stopRequested: true } : {}),
        notice:
          action === 'stop'
            ? 'Stopping… awaiting cancellation confirmation.'
            : action === 'send'
              ? 'Sending… awaiting delivery confirmation.'
              : 'Approving…',
      },
    }));
    const fingerprint = `${identity}:${action}`;
    const key = retryKeys.current.get(fingerprint) ?? crypto.randomUUID();
    if (action !== 'send') retryKeys.current.set(fingerprint, key);
    try {
      await readJson(
        `${base}/deliveries/${encodeURIComponent(deliveryId)}/${action === 'approve' ? 'interventions' : action === 'send' ? 'dispatch' : 'cancel'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            action === 'approve'
              ? { action: 'approve', idempotencyKey: key }
              : action === 'stop'
                ? { reason: 'Stopped from conversation', idempotencyKey: key }
                : {},
          ),
        },
      );
      retryKeys.current.delete(fingerprint);
      if (sessionEpoch.current === epoch) {
        setDeliveryActions((old) => ({
          ...old,
          [identity]: {
            ...old[identity],
            [action]: false,
            notice:
              action === 'send' && old[identity]?.stopRequested
                ? old[identity].notice
                : action === 'stop'
                  ? 'Cancellation recorded. Provider work may still be finishing; history is preserved.'
                  : action === 'send'
                    ? 'Send request completed. See delivery status below.'
                    : 'Approved. Choose Send to execute.',
          },
        }));
        window.dispatchEvent(new Event('symposium-deliveries-changed'));
      }
    } catch (cause) {
      if (sessionEpoch.current === epoch) {
        const detail = cause instanceof Error ? cause.message : 'Request failed';
        setDeliveryActions((old) => ({
          ...old,
          [identity]: {
            ...old[identity],
            [action]: false,
            dispatchUncertain: action === 'send' || old[identity]?.dispatchUncertain,
            notice:
              action === 'send' && old[identity]?.stopRequested
                ? old[identity].notice
                : action === 'send'
                  ? `Send outcome is uncertain. Do not resend; check delivery status or Stop. ${detail}`
                  : action === 'stop'
                    ? `Stop is unconfirmed. Check status or retry Stop. ${detail}`
                    : `Approval is unconfirmed. Check status or retry approval. ${detail}`,
          },
        }));
        window.dispatchEvent(new Event('symposium-deliveries-changed'));
      }
    } finally {
      activeActions.current.delete(actionIdentity);
    }
  };

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
        {statusError || error ? (
          <div role="alert">{statusError || error}</div>
        ) : (
          <div role="status">Loading Symposium…</div>
        )}
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
      compact={compact}
      seats={seats}
      selected={selected}
      onSelect={(next) => {
        setSelected(next);
        setShare(null);
      }}
    >
      <p className="symposium-boundary-note">
        Each seat receives explicitly granted context with its own account and tool authority. An
        aside goes only to its named recipients.
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
      {(statusError || error) && <div role="alert">{statusError || error}</div>}
      {!statusFresh && (
        <p role="status">
          Delivery status could not be refreshed. New approvals and sending are paused; Stop remains
          available.
        </p>
      )}
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
      {(status.deliveries ?? []).filter(
        (delivery) => selected === 'all' || delivery.recipientSeatIds.includes(selected),
      ).length > 0 && (
        <section aria-label="Conversation deliveries">
          <strong>Delivery review and execution</strong>
          {(status.deliveries ?? [])
            .filter(
              (delivery) => selected === 'all' || delivery.recipientSeatIds.includes(selected),
            )
            .map((delivery) => {
              const state = deliveryActions[`${base}:${delivery.deliveryId}`];
              const terminal = ['delivered', 'dropped', 'cancelled'].includes(delivery.status);
              const untouchedRecipients =
                delivery.recipients.length > 0 &&
                delivery.recipients.every((recipient) => recipient.status === 'pending');
              const recipientNames = delivery.recipientSeatIds
                .map((id) => seats.find((seat) => seat.id === id)?.name ?? id)
                .join(', ');
              return (
                <article key={delivery.deliveryId} aria-label={`Delivery to ${recipientNames}`}>
                  <details open={!terminal}>
                    <summary>
                      To{' '}
                      {delivery.recipientSeatIds.map((id, index) => (
                        <span key={id}>
                          {index > 0 && ', '}
                          <SeatLabel
                            seatId={id}
                            name={seats.find((seat) => seat.id === id)?.name ?? id}
                          />
                        </span>
                      ))}{' '}
                      · {delivery.status}
                    </summary>
                    <p>Original: {delivery.originalContent}</p>
                    {delivery.deliveredContent !== null && (
                      <p>Approved content: {delivery.deliveredContent}</p>
                    )}
                    {delivery.recipients.map((recipient) => (
                      <p key={recipient.seatId}>
                        <SeatLabel
                          seatId={recipient.seatId}
                          name={
                            seats.find((seat) => seat.id === recipient.seatId)?.name ??
                            recipient.seatId
                          }
                        />
                        : {recipient.status}
                      </p>
                    ))}
                    {state?.notice && <p role="status">{state.notice}</p>}
                    {delivery.status === 'cancelled' && !state?.notice && (
                      <p role="status">
                        Cancellation recorded. Provider cleanup is not confirmed by this receipt.
                        History is preserved.
                      </p>
                    )}
                    {delivery.status === 'awaiting_intervention' && (
                      <button
                        type="button"
                        disabled={!statusFresh || state?.approve || state?.send || state?.stop}
                        onClick={() => void controlDelivery(delivery.deliveryId, 'approve')}
                      >
                        Approve delivery to {recipientNames}
                      </button>
                    )}
                    {delivery.status === 'ready' && (
                      <button
                        type="button"
                        disabled={
                          state?.approve ||
                          state?.send ||
                          state?.stop ||
                          state?.stopRequested ||
                          state?.sendRequested ||
                          state?.dispatchUncertain ||
                          !statusFresh ||
                          !untouchedRecipients ||
                          !status.runtimeAvailable
                        }
                        onClick={() => void controlDelivery(delivery.deliveryId, 'send')}
                      >
                        Send to {recipientNames}
                      </button>
                    )}
                    {delivery.status === 'ready' && !untouchedRecipients && (
                      <p role="status">
                        Recipient execution has already started or needs recovery. Sending again is
                        unavailable here.
                      </p>
                    )}
                    {delivery.status === 'ready' && !status.runtimeAvailable && (
                      <p role="status">Provider runtime is unavailable. Sending is paused.</p>
                    )}
                    {delivery.status === 'recovery_required' && (
                      <p role="status">
                        Delivery needs recovery. Sending again is unavailable here.
                      </p>
                    )}
                    {!terminal && (
                      <button
                        type="button"
                        disabled={state?.stop}
                        onClick={() => void controlDelivery(delivery.deliveryId, 'stop')}
                      >
                        Stop delivery to {recipientNames}
                      </button>
                    )}
                    {!terminal && delivery.recipientSeatIds.length > 1 && (
                      <p>Stop applies to this entire delivery and all named recipients.</p>
                    )}
                  </details>
                </article>
              );
            })}
        </section>
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
        audience={compact && anchorSeatId ? anchorSeatId : selected}
        seats={recipientChoices}
        onSelectRecipient={
          recipientChoices.length > 1
            ? (id) => {
                if (!recipientChoices.some((seat) => seat.id === id)) return;
                setSelected(id);
                setShare(null);
              }
            : undefined
        }
        audienceLabel={
          compact
            ? (seats.find((seat) => seat.id === anchorSeatId)?.name ?? 'builder')
            : selected === 'all'
              ? 'all admitted seats'
              : seatName
        }
        recipients={recipients}
        enabled={statusFresh && recipients.length > 0}
        disabledReason={
          !statusFresh ? 'Status refresh is pending. Your draft stays here.' : undefined
        }
        onQueue={queue}
      />
    </SymposiumPerspectiveTabs>
  );
}
