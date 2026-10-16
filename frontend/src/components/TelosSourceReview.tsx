import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type {
  TelosSourcePermissionApproveRequest,
  TelosSourcePermissionPreview,
  TelosSourcePermissionPreviewRequest,
  TelosSourcePermissionReview,
  TelosSourcePacket,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { UiIcon } from './UiIcon';

const api = new TelosWorkApiClient(apiFetch);
type Prepared = {
  review: TelosSourcePermissionReview;
  preview: TelosSourcePermissionPreview;
  input: TelosSourcePermissionApproveRequest;
  pending?: ReturnType<TelosWorkApiClient['approveSourcePermission']>;
};
// A resolved permission can remove its card before the HTTP receipt arrives.
// Keep an attempted request's exact bytes in this login until receipt/recovery.
const attempted = new Map<string, Prepared>();
if (typeof window !== 'undefined')
  window.addEventListener(AUTH_LOST_EVENT, () => attempted.clear());

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function lostAuthority(error: unknown): boolean {
  return (
    errorCode(error) === 'unauthorized' ||
    (!!error &&
      typeof error === 'object' &&
      'status' in error &&
      [401, 403].includes(Number(error.status)))
  );
}
function SourceAttribution({
  attribution,
  author,
}: {
  attribution?: TelosSourcePacket['attributions'][string];
  author?: TelosSourcePacket['context']['messages'][number]['author'];
}) {
  const provenance = attribution?.provenance;
  const label =
    author === 'operator'
      ? 'You'
      : provenance && 'seatLabel' in provenance
        ? provenance.seatLabel
        : (attribution?.seatId ?? (author ? 'Assistant' : 'Author unknown'));
  const date = attribution && attribution.createdAt > 0 ? new Date(attribution.createdAt) : null;
  return (
    <small>
      {label} ·{' '}
      {date && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Source date unknown'}
    </small>
  );
}

function readBrief(text: string | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function NativeSourceProof({
  attribution,
}: {
  attribution?: TelosSourcePacket['attributions'][string];
}) {
  const provenance = attribution?.provenance;
  if (!provenance) return null;
  return (
    <p className="perm-banner-scope">
      Seat {attribution?.seatId ?? provenance.seatId} · generation{' '}
      {provenance.membershipGeneration ?? 'unknown'} · configuration {provenance.configRevision}
    </p>
  );
}
function OutcomeBrief({ brief }: { brief: Record<string, unknown> }) {
  const criteria = Array.isArray(brief.acceptanceCriteria)
    ? brief.acceptanceCriteria.filter((value): value is string => typeof value === 'string')
    : [];
  const milestones = Array.isArray(brief.milestones)
    ? brief.milestones.filter((value): value is string => typeof value === 'string')
    : [];
  return (
    <section aria-label="Outcome brief" className="telos-reviewed-brief">
      {typeof brief.intent === 'string' && (
        <>
          <h3>Outcome</h3>
          <p>{brief.intent}</p>
        </>
      )}
      {typeof brief.rationale === 'string' && (
        <>
          <h3>Why this matters</h3>
          <p>{brief.rationale}</p>
        </>
      )}
      {!!criteria.length && (
        <>
          <h3>Done when</h3>
          <ul>
            {criteria.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </>
      )}
      {!!milestones.length && (
        <>
          <h3>Milestones</h3>
          <ol>
            {milestones.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

/** Source review stays inside the ordinary approval card, shared by providers. */
export function useTelosSourceReview({
  enabled,
  permId,
  sessionId,
  expiresAt,
  recoveryOnly = false,
}: {
  enabled: boolean;
  permId: string;
  sessionId?: string;
  expiresAt: number;
  recoveryOnly?: boolean;
}) {
  const identity = JSON.stringify([sessionId, permId]);
  const current = useRef(identity);
  current.current = identity;
  const alive = useRef(false);
  const generation = useRef(0);
  const [review, setReview] = useState<TelosSourcePermissionReview | null>(null);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const [selectedArtifacts, setSelectedArtifacts] = useState<string[]>([]);
  const [preview, setPreview] = useState<TelosSourcePermissionPreview | null>(null);
  const [previewInput, setPreviewInput] = useState<TelosSourcePermissionPreviewRequest | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedItem, setSavedItem] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const loadingPage = useRef(false);
  const valid = useCallback(
    (key: string, version: number) =>
      alive.current && current.current === key && generation.current === version,
    [],
  );

  useEffect(() => {
    alive.current = true;
    generation.current++;
    const version = generation.current;
    const controller = new AbortController();
    abort.current = controller;
    setReview(null);
    setSelectedMessages([]);
    setSelectedArtifacts([]);
    setPreview(null);
    setPreviewInput(null);
    setLocked(false);
    setBlocked(false);
    setSaving(false);
    setLoading(false);
    loadingPage.current = false;
    setSaved(false);
    setSavedItem(null);
    setError(null);
    if (!enabled)
      return () => {
        alive.current = false;
        controller.abort();
      };
    const cached = attempted.get(identity);
    if (!sessionId) {
      setError('The source conversation is unavailable.');
      setBlocked(true);
    } else {
      setLoading(true);
      void api
        .getSourcePermission(permId, sessionId, controller.signal)
        .then((result) => {
          if (!valid(identity, version)) return;
          if (
            result.permId !== permId ||
            result.sessionId !== sessionId ||
            result.source.conversationId !== sessionId
          )
            throw new Error('Source request changed.');
          setReview(result);
          if (recoveryOnly && !result.recovery) throw Error('Prepared source is unavailable.');
          if (result.recovery) {
            const recovery = result.recovery;
            const restoredPreview: TelosSourcePermissionPreview = {
              permId,
              sessionId,
              requestId: recovery.requestId,
              proposalSha256: recovery.proposalSha256,
              preview: recovery.preview,
            };
            const input: TelosSourcePermissionApproveRequest = {
              sessionId,
              requestId: recovery.requestId,
              proposalSha256: recovery.proposalSha256,
              selection: recovery.selection,
              previewSha256: recovery.previewSha256,
            };
            if (
              recovery.proposalSha256 !== result.proposalSha256 ||
              recovery.preview.sha256 !== recovery.previewSha256
            )
              throw Error('Prepared source changed.');
            setPreview(restoredPreview);
            setPreviewInput(input);
            setSelectedMessages(input.selection.messageIds);
            setSelectedArtifacts(
              input.selection.artifacts.map((a) => a.artifactId + ':' + a.revision),
            );
            setLocked(true);
            if (recovery.receipt) {
              setSaved(true);
              setSavedItem(recovery.receipt.receipt.work.itemId);
            } else attempted.set(identity, { review: result, preview: restoredPreview, input });
          } else if (
            cached &&
            cached.review.toolUseId === result.toolUseId &&
            cached.review.proposalSha256 === result.proposalSha256
          ) {
            setPreview(cached.preview);
            setPreviewInput(cached.input);
            setSelectedMessages(cached.input.selection.messageIds);
            setSelectedArtifacts(
              cached.input.selection.artifacts.map((a) => a.artifactId + ':' + a.revision),
            );
            setLocked(true);
          }
        })
        .catch((failure) => {
          if (lostAuthority(failure)) attempted.delete(identity);
          if (valid(identity, version)) {
            setReview(null);
            setPreview(null);
            setPreviewInput(null);
            if (lostAuthority(failure)) setBlocked(true);
            setError(
              recoveryOnly
                ? lostAuthority(failure)
                  ? 'Sign in again to recover the original save. Dismiss only hides this card.'
                  : 'The original save is still unconfirmed. Retry recovery to retrieve the same reviewed save, or Dismiss to hide this card.'
                : 'Source review unavailable. Deny this request and ask again.',
            );
          }
        })
        .finally(() => {
          if (valid(identity, version)) setLoading(false);
        });
    }
    const authLost = () => {
      generation.current++;
      controller.abort();
      abort.current?.abort();
      loadingPage.current = false;
      setBlocked(true);
      setReview(null);
      setPreview(null);
      setPreviewInput(null);
      setSavedItem(null);
      setSaved(false);
      setSelectedMessages([]);
      setSelectedArtifacts([]);
      setLoading(false);
      setError('Sign in again before reviewing this request.');
    };
    window.addEventListener(AUTH_LOST_EVENT, authLost);
    return () => {
      alive.current = false;
      controller.abort();
      abort.current?.abort();
      window.removeEventListener(AUTH_LOST_EVENT, authLost);
    };
  }, [identity, enabled, permId, sessionId, recoveryOnly, readAttempt, valid]);

  const activeReview = review?.permId === permId && review.sessionId === sessionId ? review : null;
  const isExpired = () =>
    !recoveryOnly && Date.now() >= Math.min(expiresAt, activeReview?.expiresAt ?? expiresAt);
  const expired = isExpired();
  const disabled = loading || locked || blocked || expired;
  function changeSelection(kind: 'message' | 'artifact', id: string) {
    if (disabled) return;
    generation.current++;
    abort.current?.abort();
    loadingPage.current = false;
    setPreview(null);
    setPreviewInput(null);
    setError(null);
    const update = (values: string[]) =>
      values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
    if (kind === 'message') setSelectedMessages(update);
    else setSelectedArtifacts(update);
  }

  async function reviewSelection() {
    if (!activeReview || !sessionId || disabled || isExpired() || !selectedMessages.length) return;
    const selected = activeReview.messages.filter((m) => selectedMessages.includes(m.messageId));
    const last = selected.reduce((a, b) => (a.sequence > b.sequence ? a : b));
    const input: TelosSourcePermissionPreviewRequest = {
      sessionId,
      requestId: crypto.randomUUID(),
      proposalSha256: activeReview.proposalSha256,
      selection: {
        mode: 'selected',
        boundary: { sequence: last.sequence, messageId: last.messageId },
        messageIds: selected.map((message) => message.messageId),
        artifacts: activeReview.artifacts
          .filter((a) => selectedArtifacts.includes(a.artifactId + ':' + a.revision))
          .map(({ artifactId, revision, sha256 }) => ({ artifactId, revision, sha256 })),
      },
    };
    const version = ++generation.current;
    abort.current?.abort();
    loadingPage.current = false;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await api.previewSourcePermission(permId, input, controller.signal);
      if (!valid(identity, version)) return;
      if (
        result.permId !== permId ||
        result.sessionId !== sessionId ||
        result.requestId !== input.requestId ||
        result.proposalSha256 !== input.proposalSha256
      )
        throw Error('Source request changed.');
      setPreview(result);
      setPreviewInput(input);
    } catch {
      if (valid(identity, version))
        setError('Unable to review this source. Check the selected messages and try again.');
    } finally {
      if (valid(identity, version)) setLoading(false);
    }
  }

  async function loadMore() {
    if (!activeReview?.hasMore || !sessionId || disabled || loadingPage.current) return;
    loadingPage.current = true;
    const version = generation.current;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const page = await api.getSourcePermission(
        permId,
        sessionId,
        controller.signal,
        activeReview.cursor,
      );
      if (!valid(identity, version)) return;
      if (
        page.permId !== permId ||
        page.sessionId !== sessionId ||
        page.proposalSha256 !== activeReview.proposalSha256 ||
        page.cursor <= activeReview.cursor
      )
        throw Error('Source request changed.');
      setReview({
        ...page,
        messages: [
          ...activeReview.messages,
          ...page.messages.filter(
            (m) => !activeReview.messages.some((old) => old.messageId === m.messageId),
          ),
        ],
      });
    } catch {
      if (valid(identity, version)) setError('More source messages are unavailable. Try again.');
    } finally {
      if (abort.current === controller) loadingPage.current = false;
    }
  }

  async function approve() {
    if (!activeReview || !preview || !previewInput || saving || saved || blocked || isExpired())
      return;
    const version = generation.current;
    const prepared = attempted.get(identity) ?? {
      review: activeReview,
      preview,
      input: { ...previewInput, previewSha256: preview.preview.sha256 },
    };
    attempted.set(identity, prepared);
    setLocked(true);
    setSaving(true);
    setError(null);
    try {
      prepared.pending ??= api.approveSourcePermission(permId, prepared.input);
      const receipt = await prepared.pending;
      if (receipt.permId !== permId || receipt.sessionId !== sessionId)
        throw Error('Source receipt changed.');
      if (attempted.get(identity) === prepared) attempted.delete(identity);
      if (valid(identity, version)) {
        setSaved(true);
        setSavedItem(receipt.receipt.work.itemId);
      }
    } catch (failure) {
      prepared.pending = undefined;
      if (lostAuthority(failure)) attempted.delete(identity);
      if (valid(identity, version)) {
        const code = errorCode(failure);
        if (lostAuthority(failure)) {
          setReview(null);
          setPreview(null);
          setPreviewInput(null);
          setBlocked(true);
          setError('Sign in again before reviewing this request.');
        } else if (code && !['save_uncertain', 'unavailable'].includes(code)) {
          setBlocked(true);
          setError(
            'This request changed or is no longer authorized. Review a new request before saving.',
          );
        } else
          setError(
            recoveryOnly
              ? 'Save is unconfirmed. Retry the same save to recover this reviewed request.'
              : 'Save is unconfirmed. Retry Once to recover this exact reviewed request.',
          );
      }
    } finally {
      if (valid(identity, version)) setSaving(false);
    }
  }

  const content = enabled ? (
    <section className="telos-source-review" aria-label="Telos source review">
      {activeReview && (
        <>
          <p className="perm-banner-desc">
            {activeReview.operation.kind === 'create'
              ? `New outcome · ${activeReview.operation.outcome.summary}`
              : `Add source to existing item · ${activeReview.operation.itemId}`}
          </p>
          <p className="perm-banner-scope">
            Source · {activeReview.source.title ?? 'Untitled conversation'}
          </p>
          <OutcomeBrief
            brief={
              readBrief(preview?.preview.packet.brief.text) ??
              (activeReview.operation.kind === 'create' ? activeReview.operation.outcome : {})
            }
          />
          {!recoveryOnly && (
            <>
              <fieldset className="telos-source-choices" disabled={disabled}>
                <legend>Select the agreed exchange</legend>
                <p className="perm-banner-scope">
                  {locked
                    ? 'Your reviewed selection is fixed for this save.'
                    : 'Choose completed messages to retain. Nothing is selected automatically.'}
                </p>
                {activeReview.messages.map((message) => (
                  <label key={message.messageId} className="telos-source-choice">
                    <input
                      type="checkbox"
                      checked={selectedMessages.includes(message.messageId)}
                      disabled={!!message.unavailableReason}
                      onChange={() => changeSelection('message', message.messageId)}
                    />
                    <span>
                      <span className="telos-source-text">
                        {message.blocks.map((block) => block.content).join('\n\n')}
                      </span>
                      <SourceAttribution
                        attribution={message.attribution}
                        author={message.author}
                      />
                      {message.unavailableReason && <small>{message.unavailableReason}</small>}
                    </span>
                  </label>
                ))}
                {!activeReview.messages.length && (
                  <p className="perm-banner-scope">
                    {locked
                      ? 'Your reviewed selection is retained below.'
                      : 'No completed public messages are available.'}
                  </p>
                )}
                {activeReview.hasMore && (
                  <button type="button" className="perm-banner-btn" onClick={() => void loadMore()}>
                    Load more source messages
                  </button>
                )}
              </fieldset>
              {!!activeReview.artifacts.length && (
                <fieldset className="telos-source-choices" disabled={disabled}>
                  <legend>Select retained materials</legend>
                  {activeReview.artifacts.map((artifact) => (
                    <label
                      key={artifact.artifactId + ':' + artifact.revision}
                      className="telos-source-choice"
                    >
                      <input
                        type="checkbox"
                        checked={selectedArtifacts.includes(
                          artifact.artifactId + ':' + artifact.revision,
                        )}
                        onChange={() =>
                          changeSelection('artifact', artifact.artifactId + ':' + artifact.revision)
                        }
                      />
                      <span>
                        {artifact.title}
                        <small>
                          {artifact.filename} · revision {artifact.revision} · {artifact.sizeBytes}{' '}
                          bytes
                        </small>
                        <small>
                          Created {artifact.createdAt ?? 'date unknown'} ·{' '}
                          {artifact.sessionId === activeReview.source.conversationId
                            ? (activeReview.source.title ?? 'This conversation')
                            : 'Source conversation recorded'}
                        </small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <button
                type="button"
                className="perm-banner-btn"
                disabled={disabled || !selectedMessages.length}
                onClick={() => void reviewSelection()}
              >
                Review selected source
              </button>
            </>
          )}
        </>
      )}
      {loading && (
        <p role="status" className="perm-banner-scope">
          Loading source review…
        </p>
      )}
      {preview && activeReview && (
        <section aria-label="Reviewed source">
          <h3>Reviewed source</h3>
          {preview.preview.packet.context.messages.map((message) => (
            <div key={message.messageId}>
              <SourceAttribution
                attribution={preview.preview.packet.attributions?.[message.messageId]}
                author={message.author}
              />
              {message.blocks.map((block) => (
                <p className="telos-source-text" key={block.blockId}>
                  {block.content}
                </p>
              ))}
            </div>
          ))}
        </section>
      )}
      {activeReview && (
        <details className="perm-banner-details">
          <summary>
            <UiIcon name="forward" size={16} />
            Source details
          </summary>
          {activeReview.messages.map((message) => (
            <div key={message.messageId}>
              <p className="perm-banner-scope">
                Message {message.messageId} · sequence {message.sequence} · author{' '}
                {message.author === 'operator' ? 'operator' : message.author.sessionId}
              </p>
              <p className="perm-banner-scope">
                Blocks {message.blocks.map((block) => block.blockId).join(', ')}
              </p>
              <NativeSourceProof attribution={message.attribution} />
            </div>
          ))}
          {activeReview.artifacts.map((artifact) => (
            <p className="perm-banner-scope" key={artifact.artifactId + ':' + artifact.revision}>
              Artifact {artifact.artifactId} · revision {artifact.revision} · source{' '}
              {artifact.sessionId} · SHA-256 {artifact.sha256}
            </p>
          ))}
          {preview && (
            <>
              <p className="perm-banner-scope">
                Boundary · {preview.preview.packet.context.boundary.messageId} · sequence{' '}
                {preview.preview.packet.context.boundary.sequence}
              </p>
              <p className="perm-banner-scope">SHA-256 {preview.preview.sha256}</p>
              {preview.preview.packet.context.messages.map((message) => (
                <div key={message.messageId}>
                  <p className="perm-banner-scope">
                    Reviewed message {message.messageId} · blocks{' '}
                    {message.blocks.map((block) => block.blockId).join(', ')}
                  </p>
                  <NativeSourceProof
                    attribution={preview.preview.packet.attributions?.[message.messageId]}
                  />
                </div>
              ))}
              {preview.preview.packet.context.artifacts.map((artifact) => (
                <p
                  className="perm-banner-scope"
                  key={artifact.artifactId + ':' + artifact.revision}
                >
                  Artifact {artifact.artifactId} · revision {artifact.revision} ·{' '}
                  {artifact.mediaType} · {artifact.sizeBytes} bytes · SHA-256 {artifact.sha256}
                </p>
              ))}
              <pre className="perm-banner-input">{preview.preview.packet.brief.text}</pre>
            </>
          )}
        </details>
      )}
      {error && (
        <p role="alert" className="perm-banner-response-error">
          {error}
        </p>
      )}
      {recoveryOnly && error && !activeReview && !loading && !blocked && (
        <button
          type="button"
          className="perm-banner-btn"
          onClick={() => setReadAttempt((attempt) => attempt + 1)}
        >
          Retry recovery
        </button>
      )}
      {saved && (
        <p role="status" className="perm-banner-scope">
          Reviewed source saved.
          {savedItem && (
            <>
              {' '}
              <Link to={'/todos/' + encodeURIComponent(savedItem)}>Open saved item</Link>
            </>
          )}
        </p>
      )}
    </section>
  ) : null;
  return {
    content,
    approve,
    saving,
    saved,
    authorized: !!activeReview && !blocked,
    ready: !!activeReview && !!preview && !loading && !saving && !saved && !blocked && !expired,
  };
}
