import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { MitzoNotification } from '@mitzo/protocol';
import type { PermissionRequest } from '../types/chat';
import { readApiJson } from '../lib/api-json-read';
import { PermissionBanner, type PermissionDraft } from './PermissionBanner';
import type { ChatAreaProps } from './ChatArea';
import { ApprovalDraftStore, approvalDraftContext } from '../hooks/approval-draft-context';

interface Props {
  sessionId?: string;
  permission: PermissionRequest | null;
  permissionQueue?: PermissionRequest[];
  requestedApprovalId?: string | null;
  approvalNavigationKey?: string;
  ready?: boolean;
  onPermissionRespond: ChatAreaProps['onPermissionRespond'];
  onPermissionExpire?: ChatAreaProps['onPermissionExpire'];
}

/** Selection never changes the authoritative pending queue or submits a decision. */
export function ChatApprovalQueue({
  sessionId,
  permission,
  permissionQueue = [],
  requestedApprovalId,
  approvalNavigationKey,
  ready = true,
  onPermissionRespond,
  onPermissionExpire,
}: Props) {
  const sharedStore = useContext(approvalDraftContext);
  const localStore = useMemo(() => new ApprovalDraftStore(sessionId), [sessionId]);
  const store = sharedStore ?? localStore;
  const drafts = store.requests;
  const pending = [
    ...new Map(
      [permission, ...permissionQueue]
        .filter((request): request is PermissionRequest => !!request)
        .map((request) => [request.permId, request]),
    ).values(),
  ];
  const scope = JSON.stringify([sessionId, requestedApprovalId, approvalNavigationKey]);
  const [selection, setSelection] = useState(
    () => store.selection ?? { scope, id: requestedApprovalId, seen: false },
  );
  const choice =
    selection.scope === scope ? selection : { scope, id: requestedApprovalId, seen: false };
  const selected = ready
    ? (pending.find((request) => request.permId === choice.id) ??
      (!choice.id || choice.seen ? pending[0] : undefined))
    : undefined;
  const selectedId = selected?.permId;
  useEffect(() => {
    store.selection = { scope, id: selectedId ?? choice.id, seen: !!selectedId || choice.seen };
  }, [store, scope, selectedId, choice.id, choice.seen]);
  useEffect(() => {
    if (selectedId)
      setSelection((previous) =>
        previous.scope === scope && previous.id === selectedId && previous.seen
          ? previous
          : { scope, id: selectedId, seen: true },
      );
  }, [scope, selectedId]);
  const saveDraft = useCallback(
    (draft: PermissionDraft) => {
      if (selectedId) drafts.set(selectedId, draft);
    },
    [drafts, selectedId],
  );
  const liveIds = JSON.stringify(pending.map((request) => request.permId));
  useEffect(() => {
    if (!ready) return;
    const live = new Set<string>(JSON.parse(liveIds));
    for (const id of drafts.keys()) if (!live.has(id)) drafts.delete(id);
  }, [drafts, liveIds, ready]);

  const [status, setStatus] = useState({ scope: '', text: '', failed: false });
  const [retry, setRetry] = useState(0);
  const missing = !!requestedApprovalId && !selected && !choice.seen;
  useEffect(() => {
    if (!ready || !missing || !sessionId) return;
    const controller = new AbortController();
    setStatus({ scope, text: 'Loading this approval…', failed: false });
    const id = `permission:${requestedApprovalId}`;
    readApiJson<MitzoNotification>(
      `/api/notifications/${encodeURIComponent(id)}`,
      controller.signal,
    )
      .then((item) => {
        if (controller.signal.aborted) return;
        let text = 'Loading this approval…';
        if (item.id !== id || item.sessionId !== sessionId)
          text = 'This request is not available in this chat.';
        else if (item.resolution === 'expired') text = 'This request has expired.';
        else if (item.resolution || item.resolvedAt != null)
          text = 'This request was already handled.';
        else if (item.expiresAt != null && item.expiresAt <= Date.now())
          text = 'This request has expired.';
        setStatus({ scope, text, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus({ scope, text: 'Cannot load this request. Try again.', failed: true });
      });
    return () => controller.abort();
  }, [scope, missing, ready, requestedApprovalId, sessionId, retry]);

  const navigation =
    ready && pending.length > (selected ? 1 : 0) ? (
      <label className="perm-banner-navigation">
        <span>{pending.length} pending</span>
        <select
          className="perm-banner-btn"
          aria-label="Pending approvals"
          value={selectedId ?? ''}
          onChange={(event) => setSelection({ scope, id: event.target.value, seen: false })}
        >
          {!selected && <option value="">Choose a pending request</option>}
          {pending.map((request, index) => (
            <option key={request.permId} value={request.permId}>
              {index + 1}. {request.title || request.displayName || request.toolName}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;
  if (!selected)
    return missing ? (
      <div className="chat-approval-status" role="status">
        <p>{status.scope === scope ? status.text : 'Loading this approval…'}</p>
        {status.scope === scope && status.failed && (
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        )}
        {navigation}
      </div>
    ) : null;
  return (
    <PermissionBanner
      key={`${sessionId}:${selected.permId}`}
      {...selected}
      sessionId={sessionId ?? selected.sessionId}
      navigation={navigation}
      draft={drafts.get(selected.permId)}
      onDraftChange={saveDraft}
      onRespond={onPermissionRespond}
      onExpire={onPermissionExpire}
    />
  );
}
