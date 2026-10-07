import {
  symposiumQueueOperations,
  symposiumExcerptOperations,
  matchesQueuedMessage,
  type QueueOperation,
} from '../lib/symposium-queue-operations';
import {
  controlSymposiumDelivery,
  getSymposiumDeliveryActions,
} from '../lib/symposium-delivery-actions';
import { canRequestAgent, canRequestRuntime } from '../lib/symposium-status';
import { SeatLabel } from './SeatLabel';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type {
  FinishedMessage,
  StreamingMessage,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumProvenance,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { ChatArea, type ChatAreaProps, type SymposiumContextItem } from './ChatArea';
import { UiIcon } from './UiIcon';
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
  runtimeVerification?: string;
  seats: {
    seatId: string;
    seat: Omit<SeatProfileSeed, 'seatId'>;
    admitted: boolean;
    admissionRecorded?: boolean;
    savedRuntimeState?: string | null;
    creationDiagnostic?: unknown;
    membership?: { state: string; reconciliation?: string } | null;
  }[];
};

class SymposiumRequestError extends Error {
  constructor(
    message: string,
    readonly dispatchNotStarted: boolean,
  ) {
    super(message);
  }
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (response.status === 404 && url.endsWith('/status'))
    throw new Error(
      'This server does not support saved agent status. Update the server before continuing.',
    );
  const body = (await response.json()) as T & { error?: string; dispatch?: unknown };
  if (!response.ok)
    throw new SymposiumRequestError(
      body.error || `Request failed (${response.status})`,
      body.dispatch === 'not-started',
    );
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
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [page, setPage] = useState<PerspectivePage>({ items: [], nextSeq: null, queued: [] });
  const [pageFor, setPageFor] = useState('');
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [share, setShare] = useState<Authored | null>(null);
  const [excerpt, setExcerpt] = useState('');
  const [shareRecipients, setShareRecipients] = useState<string[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const queueOperations = useSyncExternalStore(
    symposiumQueueOperations.subscribe,
    symposiumQueueOperations.snapshot,
  );
  const queuedOperation = sessionId ? queueOperations[sessionId] : undefined;
  const excerptOperations = useSyncExternalStore(
    symposiumExcerptOperations.subscribe,
    symposiumExcerptOperations.snapshot,
  );
  const excerptOperation = sessionId ? excerptOperations[sessionId] : undefined;
  const deliveryStore = getSymposiumDeliveryActions();
  const deliveryActions = useSyncExternalStore(deliveryStore.subscribe, deliveryStore.snapshot);
  const [seatSeed, setSeatSeed] = useState<SeatProfileSeed | null>(null);
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
    setProfilesOpen(false);
    setPage({ items: [], nextSeq: null, queued: [] });
    if (!base) return;
    let cancelled = false;
    let cancelRead: (() => void) | null = null;
    // Coalesce reads within this session only. A stalled retired request must
    // never delay the new session's status or its Stop controls.
    const statusQueue: { running: boolean; pending: (() => Promise<void>) | null } = {
      running: false,
      pending: null,
    };
    const refresh = async () => {
      if (cancelled) return;
      if (statusQueue.running) {
        statusQueue.pending = refresh;
        return;
      }
      statusQueue.running = true;
      const controller = new AbortController();
      let deadline: number | undefined;
      // Bound the entire read, including JSON decoding. The race releases the
      // queue even if a transport ignores abort; its late result cannot apply.
      const expired = new Promise<never>((_, reject) => {
        cancelRead = () => {
          controller.abort();
          reject(new Error('Symposium status request cancelled.'));
        };
        deadline = window.setTimeout(() => {
          controller.abort();
          reject(new Error('Symposium status request timed out.'));
        }, 30_000);
      });
      try {
        const next = await Promise.race([
          readJson<Status>(`${base}/status`, { signal: controller.signal }),
          expired,
        ]);
        if (next.sessionId !== sessionId || !Array.isArray(next.seats) || !('config' in next))
          throw new Error('Symposium status is incomplete');
        if (!cancelled) {
          symposiumQueueOperations.reconcile(sessionId!, next.deliveries ?? []);
          symposiumExcerptOperations.reconcile(sessionId!, next.deliveries ?? []);
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
      } finally {
        window.clearTimeout(deadline);
        cancelRead = null;
        statusQueue.running = false;
        const pending = statusQueue.pending;
        statusQueue.pending = null;
        if (pending) void pending();
      }
    };
    void refresh();
    const onRosterChanged = () => void refresh();
    window.addEventListener('symposium-roster-changed', onRosterChanged);
    window.addEventListener('symposium-deliveries-changed', onRosterChanged);
    const timer = window.setInterval(() => void refresh(), 8000);
    const lifecycle = sessionEpoch;
    return () => {
      lifecycle.current += 1;
      cancelled = true;
      cancelRead?.();
      if (statusQueue.pending === refresh) statusQueue.pending = null;
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
    () => status?.seats?.filter(canRequestAgent).map((seat) => seat.seatId) ?? [],
    [status],
  );
  const anchorSeatId = status?.config?.version === 2 ? status.config.anchorSeatId : undefined;
  const compact = Boolean(
    status?.config?.version === 2 &&
    status.config.state === 'active' &&
    status.seats.some((seat) => seat.seatId === anchorSeatId && canRequestAgent(seat)) &&
    status.seats
      .filter((seat) => seat.seatId !== anchorSeatId)
      .every((seat) => seat.membership?.state === 'removed'),
  );
  useEffect(() => {
    if (compact && anchorSeatId) {
      setSelected(anchorSeatId);
      setShare(null);
    }
  }, [compact, anchorSeatId]);
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
      if (!sessionId || !base || symposiumQueueOperations.snapshot()[sessionId]) return false;
      const epoch = sessionEpoch.current;
      const operation: QueueOperation = {
        sessionId,
        request: {
          sourceSeatId: null,
          recipientSeatIds: [...recipients].sort(),
          originalContent: content,
          idempotencyKey: crypto.randomUUID(),
        },
        phase: 'pending',
        notice: 'Checking whether this message was queued…',
      };
      if (!symposiumQueueOperations.begin(operation)) return false;
      const key = operation.request.idempotencyKey;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const receipt = await Promise.race([
          readJson<SymposiumDeliveryRecord>(`${base}/deliveries`, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(operation.request),
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error('The queue request timed out. Check whether this message was queued.'),
              );
              controller.abort();
            }, 30_000);
          }),
        ]);
        if (!matchesQueuedMessage(operation, receipt))
          throw new Error(
            'The queue response did not confirm this message. Check whether it was queued.',
          );
        symposiumQueueOperations.update(sessionId, key, (previous) => ({
          ...previous,
          phase: 'confirmed',
          deliveryId: receipt.deliveryId,
          notice: 'Message already queued',
        }));
        if (sessionEpoch.current !== epoch) return false;
        symposiumQueueOperations.update(sessionId, key, () => undefined);
        window.dispatchEvent(new Event('symposium-deliveries-changed'));
        return true;
      } catch (cause) {
        symposiumQueueOperations.update(sessionId, key, (previous) =>
          previous.phase === 'confirmed'
            ? previous
            : { ...previous, phase: 'uncertain', notice: 'Check whether this message was queued.' },
        );
        if (sessionEpoch.current !== epoch) return false;
        throw cause;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    [base, sessionId],
  );
  const submitShare = useCallback(async () => {
    if (
      !sessionId ||
      !share ||
      !excerpt.trim() ||
      !share.content.includes(excerpt.trim()) ||
      shareRecipients.length === 0 ||
      symposiumExcerptOperations.snapshot()[sessionId]
    )
      return;
    const operation: QueueOperation = {
      sessionId,
      request: {
        sourceMessageId: share.messageId,
        sourceSeatId: share.seatId,
        ...(share.provenance?.membershipGeneration !== undefined
          ? { sourceMembershipGeneration: share.provenance.membershipGeneration }
          : {}),
        originalContent: excerpt.trim(),
        recipientSeatIds: [...shareRecipients].sort(),
        idempotencyKey: crypto.randomUUID(),
      },
      sourceProvenance: structuredClone(share.provenance),
      phase: 'pending',
      notice: 'Checking whether this excerpt was queued…',
    };
    if (!symposiumExcerptOperations.begin(operation)) return;
    const key = operation.request.idempotencyKey;
    const epoch = sessionEpoch.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setShareBusy(true);
    try {
      const { originalContent, ...request } = operation.request;
      const receipt = await Promise.race([
        readJson<SymposiumDeliveryRecord>(`${base}/share-excerpt`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, excerpt: originalContent }),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error('The excerpt request timed out. Check whether this excerpt was queued.'),
            );
            controller.abort();
          }, 30_000);
        }),
      ]);
      if (!matchesQueuedMessage(operation, receipt))
        throw new Error(
          'The queue response did not confirm this excerpt. Check whether it was queued.',
        );
      symposiumExcerptOperations.update(sessionId, key, (previous) => ({
        ...previous,
        phase: 'confirmed',
        deliveryId: receipt.deliveryId,
        notice: 'Excerpt already queued',
      }));
      if (sessionEpoch.current === epoch) {
        symposiumExcerptOperations.update(sessionId, key, () => undefined);
        setShare(null);
        setError('');
        window.dispatchEvent(new Event('symposium-deliveries-changed'));
      }
    } catch (cause) {
      symposiumExcerptOperations.update(sessionId, key, (previous) =>
        previous.phase === 'confirmed'
          ? previous
          : { ...previous, phase: 'uncertain', notice: 'Check whether this excerpt was queued.' },
      );
      if (sessionEpoch.current === epoch)
        setError(cause instanceof Error ? cause.message : 'Could not share excerpt');
    } finally {
      if (timer) clearTimeout(timer);
      if (sessionEpoch.current === epoch) setShareBusy(false);
    }
  }, [base, sessionId, share, excerpt, shareRecipients]);
  const controlDelivery = async (deliveryId: string, action: 'approve' | 'send' | 'stop') => {
    if (
      selected === 'all' ||
      !status?.deliveries?.some(
        (delivery) =>
          delivery.deliveryId === deliveryId && delivery.recipientSeatIds.includes(selected),
      )
    )
      return;
    const epoch = sessionEpoch.current;
    const requested = await controlSymposiumDelivery(deliveryStore, base, deliveryId, action);
    if (requested && sessionEpoch.current === epoch)
      window.dispatchEvent(new Event('symposium-deliveries-changed'));
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
        {/* Keep the input area visible without mounting queue/send effects. */}
        <div className="chat-input" aria-busy="true">
          <div className="chat-input-row">
            <textarea
              className="chat-input-field"
              aria-label="Message Mitzo"
              placeholder="Message Mitzo..."
              rows={1}
              disabled
            />
            <div className="composer-toolbar">
              <div className="composer-actions">
                <button
                  type="button"
                  className="chat-input-btn chat-input-btn--send"
                  aria-label="Send message"
                  disabled
                >
                  <UiIcon name="send" />
                </button>
              </div>
            </div>
          </div>
        </div>
        {(statusError || error) && <div role="alert">{statusError || error}</div>}
      </>
    );
  if (!status?.config)
    return (
      <>
        {chat && <ChatArea {...chat} />}
        {sessionId && (
          <div className="symposium-profile-tools">
            <button
              type="button"
              aria-expanded={profilesOpen}
              onClick={() => setProfilesOpen(!profilesOpen)}
            >
              Profiles and advanced guidance
            </button>
            {profilesOpen && <SymposiumProfileProposals key={sessionId} sessionId={sessionId} />}
          </div>
        )}
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
        Messages go to the agents you select. File access follows each agent’s permissions.
      </p>
      <div className="symposium-profile-tools">
        <button
          type="button"
          aria-expanded={profilesOpen}
          onClick={() => setProfilesOpen(!profilesOpen)}
        >
          Profiles and advanced guidance
        </button>
        {profilesOpen && (
          <>
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
          </>
        )}
      </div>
      {queuedOperation && (
        <section aria-label="Saved queued message">
          <p role="status">{queuedOperation.notice}</p>
          <p>Message: {queuedOperation.request.originalContent}</p>
          {queuedOperation.phase === 'confirmed' ? (
            <button
              type="button"
              onClick={() =>
                symposiumQueueOperations.update(
                  queuedOperation.sessionId,
                  queuedOperation.request.idempotencyKey,
                  () => undefined,
                )
              }
            >
              Write another message
            </button>
          ) : (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('symposium-deliveries-changed'))}
            >
              Check whether this message was queued
            </button>
          )}
        </section>
      )}
      {excerptOperation && (
        <section aria-label="Saved queued excerpt">
          <p role="status">{excerptOperation.notice}</p>
          <p>Excerpt: {excerptOperation.request.originalContent}</p>
          {excerptOperation.phase === 'confirmed' ? (
            <button
              type="button"
              onClick={() =>
                symposiumExcerptOperations.update(
                  excerptOperation.sessionId,
                  excerptOperation.request.idempotencyKey,
                  () => undefined,
                )
              }
            >
              Share another excerpt
            </button>
          ) : (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event('symposium-deliveries-changed'))}
            >
              Check whether this excerpt was queued
            </button>
          )}
        </section>
      )}
      {(statusError || error) && <div role="alert">{statusError || error}</div>}
      {!statusFresh && (
        <p role="status">
          Delivery status could not be refreshed. New approvals and sending are paused; Stop remains
          available in the recipient agent stream.
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
        afterMessages={
          <>
            {visiblePage.queued.filter(
              (item) => selected === 'all' || item.recipientSeatId === selected,
            ).length > 0 && (
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
              <section className="symposium-deliveries" aria-label="Conversation deliveries">
                <strong>Delivery review and execution</strong>
                {(status.deliveries ?? [])
                  .filter(
                    (delivery) =>
                      selected === 'all' || delivery.recipientSeatIds.includes(selected),
                  )
                  .map((delivery) => {
                    const state = deliveryActions[`${base}:${delivery.deliveryId}`];
                    const terminal = ['delivered', 'dropped', 'cancelled'].includes(
                      delivery.status,
                    );
                    const untouchedRecipients =
                      delivery.recipients.length > 0 &&
                      delivery.recipients.every((recipient) => recipient.status === 'pending');
                    const recipientNames = delivery.recipientSeatIds
                      .map((id) => seats.find((seat) => seat.id === id)?.name ?? id)
                      .join(', ');
                    return (
                      <article
                        className="symposium-delivery-card"
                        key={delivery.deliveryId}
                        aria-label={`Delivery to ${recipientNames}`}
                      >
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
                              Cancellation recorded. Provider cleanup is not confirmed by this
                              receipt. History is preserved.
                            </p>
                          )}
                          {selected !== 'all' && delivery.status === 'awaiting_intervention' && (
                            <button
                              type="button"
                              disabled={
                                !statusFresh || state?.approve || state?.send || state?.stop
                              }
                              onClick={() => void controlDelivery(delivery.deliveryId, 'approve')}
                            >
                              Approve delivery to {recipientNames}
                            </button>
                          )}
                          {selected !== 'all' && delivery.status === 'ready' && (
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
                                !canRequestRuntime(status)
                              }
                              onClick={() => void controlDelivery(delivery.deliveryId, 'send')}
                            >
                              Send to {recipientNames}
                            </button>
                          )}
                          {delivery.status === 'ready' && !untouchedRecipients && (
                            <p role="status">
                              Recipient execution has already started or needs recovery. Sending
                              again is unavailable here.
                            </p>
                          )}
                          {delivery.status === 'ready' && !canRequestRuntime(status) && (
                            <p role="status">Provider runtime is unavailable. Sending is paused.</p>
                          )}
                          {delivery.status === 'recovery_required' && (
                            <p role="status">
                              Delivery needs recovery. Sending again is unavailable here.
                            </p>
                          )}
                          {selected !== 'all' && !terminal && (
                            <button
                              type="button"
                              disabled={state?.stop}
                              onClick={() => void controlDelivery(delivery.deliveryId, 'stop')}
                            >
                              Stop delivery to {recipientNames}
                            </button>
                          )}
                          {selected !== 'all' &&
                            !terminal &&
                            delivery.recipientSeatIds.length > 1 && (
                              <p>Stop applies to this entire delivery and all named recipients.</p>
                            )}
                        </details>
                      </article>
                    );
                  })}
              </section>
            )}
          </>
        }
      />
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
              Boolean(excerptOperation) ||
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
        key={sessionId}
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
        enabled={statusFresh && recipients.length > 0 && !queuedOperation}
        disabledReason={
          queuedOperation
            ? 'Check the saved queued message before sending another.'
            : !statusFresh
              ? 'Status refresh is pending. Your draft stays here.'
              : undefined
        }
        onQueue={queue}
      />
    </SymposiumPerspectiveTabs>
  );
}
