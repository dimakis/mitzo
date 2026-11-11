import { useState, useEffect, useRef, useMemo } from 'react';
import { OperationCard } from './OperationCard';
import { WorkspaceActionMenu, type WorkspaceMenuItem } from './WorkspaceActionMenu';
import { ApprovalRequestSummary } from './ApprovalRequestSummary';
import { approvalPresentation } from '../lib/approval-presentation';
import { useTelosSourceReview } from './TelosSourceReview';
import { sessionApprovalServer, type QuestionAnswers, type UserQuestion } from '@mitzo/protocol';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';
export interface ApprovalCardProps {
  presentation?: 'overlay' | 'inline' | 'entry';
  responseTransport?: 'chat' | 'notification';
  busy?: boolean;
  permId: string;
  sessionId?: string;
  reviewKind?: 'telos_source';
  recoveryOnly?: true;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  summary?: string;
  displayName?: string;
  tier?: ToolTier;
  approvalScope?: 'session' | 'conversation' | 'request';
  allowSessionGrant?: boolean;
  sessionGrantDescription?: string;
  responseError?: string;
  /** Notification consumers retain their mutation error in the page banner. */
  showResponseError?: boolean;
  expiresAt?: number;
  questions?: UserQuestion[];
  onExpire?: (permId: string) => void;
  onRespond: (
    permId: string,
    decision: 'once' | 'always' | 'deny',
    toolName: string,
    answers?: QuestionAnswers,
  ) => void;
}
const TIER_LABELS: Record<ToolTier, string> = {
  safe: 'Read only',
  standard: 'File edit',
  elevated: 'Shell Access',
  unknown: 'External tool',
};

export function ApprovalCard({
  presentation = 'inline',
  responseTransport = 'chat',
  busy = false,
  permId,
  sessionId,
  reviewKind,
  recoveryOnly,
  toolName,
  toolInput,
  title,
  description,
  summary,
  displayName,
  tier,
  approvalScope,
  allowSessionGrant,
  responseError,
  showResponseError = true,
  sessionGrantDescription,
  questions,
  expiresAt,
  onRespond,
  onExpire,
}: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    if (responseError && submitting) {
      sending.current = false;
      setSubmitting(false);
    }
  }, [responseError, submitting]);
  const respond: ApprovalCardProps['onRespond'] = (id, decision, tool, answers) => {
    if (sending.current || busy) return;
    sending.current = true;
    setSubmitting(true);
    if (
      decision === 'once' &&
      approvalScope === 'conversation' &&
      responseTransport === 'notification'
    )
      decision = 'always';
    if (answers) onRespond(id, decision, tool, answers);
    else onRespond(id, decision, tool);
  };
  const [selections, setSelections] = useState<Map<string, string[]>>(() => new Map());
  const [written, setWritten] = useState<Map<string, string>>(() => new Map());
  const deadline = useMemo(
    () => ({
      id: permId,
      at: expiresAt ?? (presentation === 'overlay' ? Date.now() + 120_000 : Infinity),
    }),
    [permId, expiresAt, presentation],
  );
  const sourceReview = useTelosSourceReview({
    enabled: reviewKind === 'telos_source',
    permId,
    sessionId,
    expiresAt: deadline.at,
    recoveryOnly: reviewKind === 'telos_source' && recoveryOnly === true,
  });
  const reviewingSource = reviewKind === 'telos_source';
  const creatingOutcome =
    reviewingSource && ['TelosCreateOutcome', 'mcp__telos__TelosCreateOutcome'].includes(toolName);
  const [detailsOpen, setDetailsOpen] = useState(reviewingSource);
  const actionsRef = useRef<HTMLDivElement>(null);
  const wasRequestingChanges = useRef(false);
  useEffect(() => {
    if (sourceReview.requestingChanges) {
      if (!detailsOpen) setDetailsOpen(true);
      else document.getElementById('telos-feedback-' + permId)?.focus();
    } else if (wasRequestingChanges.current && !sourceReview.changesSent)
      actionsRef.current
        ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
        ?.focus({ preventScroll: true });
    wasRequestingChanges.current = sourceReview.requestingChanges;
  }, [sourceReview.requestingChanges, sourceReview.changesSent, permId, detailsOpen]);
  const recoveringSource = reviewingSource && recoveryOnly === true;
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000)),
  );
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  useEffect(() => {
    if (recoveringSource || !Number.isFinite(deadline.at)) return;
    let expired = false;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !expired) {
        expired = true;
        expireRef.current?.(permId);
      }
    };
    update();
    if (deadline.at <= Date.now()) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [deadline, permId, recoveringSource]);
  useEffect(() => {
    sending.current = false;
    setSubmitting(false);
    setSelections(new Map());
    setWritten(new Map());
    setDetailsOpen(reviewKind === 'telos_source');
  }, [permId, reviewKind]);

  const answers = Object.fromEntries(
    (questions ?? []).map((q) => [
      q.id,
      [
        ...(selections.get(q.id) ?? []),
        ...(written.get(q.id)?.trim() ? [written.get(q.id)!.trim()] : []),
      ],
    ]),
  );
  const complete = questions?.every((q) => answers[q.id].length > 0);
  const display = approvalPresentation(toolInput, toolName);
  const intent = !display.facts.length ? toolInput : undefined;
  const heading = questions
    ? 'A question for you'
    : reviewingSource
      ? recoveringSource
        ? 'Recover Telos save'
        : 'Save to Telos'
      : display.heading || title || displayName || toolName;
  let sessionSearch = false;
  if (toolName === 'RequestWebAccess' && approvalScope === 'session' && !questions) {
    try {
      sessionSearch = JSON.parse(toolInput).operation === 'search';
    } catch {
      // Unknown input retains the ordinary approval description.
    }
  }
  const server = sessionApprovalServer(toolName);
  const tierClass =
    tier === 'elevated'
      ? ' perm-banner--elevated'
      : tier === 'unknown'
        ? ' perm-banner--unknown'
        : '';

  const locked = busy || submitting || sourceReview.saving || sourceReview.changesSending;
  const secondary: WorkspaceMenuItem[] = [];
  if (
    !questions &&
    !reviewingSource &&
    approvalScope !== 'conversation' &&
    allowSessionGrant !== false
  )
    secondary.push({
      id: 'session',
      label: sessionSearch ? 'Approve searches for this session' : 'Approve for session',
      disabled: locked || remaining === 0,
      onSelect: () => respond(permId, 'always', toolName),
    });
  if (sourceReview.requestingChanges)
    secondary.push({
      id: 'back',
      label: 'Back to proposal',
      disabled: sourceReview.changesLocked || sourceReview.changesSending,
      onSelect: sourceReview.backToProposal,
    });
  else if (sourceReview.canRequestChanges)
    secondary.push({
      id: 'changes',
      label: 'Request changes',
      disabled: locked,
      onSelect: sourceReview.startChanges,
    });
  secondary.push({
    id: 'deny',
    label: recoveringSource ? 'Dismiss' : questions || creatingOutcome ? 'Cancel' : 'Deny',
    danger: true,
    disabled: locked || sourceReview.changesLocked || (!recoveringSource && sourceReview.saved),
    onSelect: () => respond(permId, 'deny', toolName),
  });
  const scope = questions
    ? 'Answer required · no permission grant'
    : reviewingSource
      ? 'Selected source only'
      : approvalScope === 'conversation'
        ? 'This conversation · until revoked'
        : allowSessionGrant === false
          ? 'Once · this request only'
          : 'Once, or this session';
  const actions = (
    <div className="operation-actions" ref={actionsRef}>
      {questions ? (
        <button
          className="operation-primary"
          disabled={busy || submitting || !complete || remaining === 0}
          onClick={() => respond(permId, 'once', toolName, answers)}
        >
          Send answer
        </button>
      ) : (
        <>
          <button
            className="operation-primary"
            aria-label={
              sourceReview.requestingChanges
                ? sourceReview.changesLocked && !sourceReview.changesSending
                  ? 'Retry sending changes'
                  : 'Send changes'
                : recoveringSource
                  ? 'Retry same save'
                  : sourceReview.quickSave
                    ? 'Create outcome'
                    : approvalScope === 'conversation'
                      ? 'Grant to conversation'
                      : 'Approve once'
            }
            disabled={
              busy ||
              submitting ||
              (!recoveringSource && remaining === 0) ||
              (sourceReview.requestingChanges
                ? !sourceReview.feedbackReady ||
                  sourceReview.changesSending ||
                  sourceReview.changesSent
                : reviewingSource && !sourceReview.ready)
            }
            onClick={() =>
              sourceReview.requestingChanges
                ? void sourceReview.sendChanges()
                : reviewingSource
                  ? void sourceReview.approve()
                  : respond(permId, 'once', toolName)
            }
          >
            {sourceReview.requestingChanges
              ? sourceReview.changesSending
                ? 'Sending…'
                : sourceReview.changesLocked
                  ? 'Retry sending changes'
                  : 'Send changes'
              : recoveringSource
                ? 'Retry same save'
                : sourceReview.quickSave
                  ? sourceReview.saving
                    ? 'Creating…'
                    : 'Create outcome'
                  : approvalScope === 'conversation'
                    ? 'Grant'
                    : 'Approve'}
          </button>
        </>
      )}
      <WorkspaceActionMenu label="More approval actions" items={secondary} disabled={locked} />
    </div>
  );
  if (!recoveringSource && (remaining === 0 || deadline.at <= Date.now())) {
    if (presentation === 'overlay') return null;
    return (
      <OperationCard title={heading} kind="Approval expired" icon="clock" status="Expired">
        <p>Request expired. No approval was submitted.</p>
      </OperationCard>
    );
  }
  return (
    <OperationCard
      title={heading}
      kind={
        questions
          ? 'Question'
          : reviewingSource
            ? 'Source review'
            : tier
              ? TIER_LABELS[tier]
              : 'Approval required'
      }
      icon={
        questions ? 'chats' : reviewingSource ? 'work' : tier === 'elevated' ? 'terminal' : 'shield'
      }
      scope={
        <>
          {!questions && !reviewingSource && <span className="operation-intent">{intent}</span>}
          {summary && <span className="operation-context">{summary}</span>}
          <span>{scope}</span>
        </>
      }
      actions={actions}
      details={
        !questions &&
        (reviewingSource ? (
          sourceReview.content
        ) : (
          <>
            {description && <p>{description}</p>}
            <pre className="perm-banner-input">{toolInput}</pre>
          </>
        ))
      }
      toggleLabel="Request details"
      expanded={detailsOpen}
      onExpandedChange={setDetailsOpen}
      pending
      busy={locked}
      className={
        presentation === 'overlay'
          ? `perm-banner perm-banner--visible operation-card--overlay${tierClass}`
          : 'approval-card'
      }
      label={
        questions ? 'Agent questions' : recoveringSource ? 'Save recovery' : 'Approval required'
      }
    >
      {(submitting || sourceReview.saving) && (
        <p className="perm-banner-submitting" role="status">
          Sending response…
        </p>
      )}
      {responseError && showResponseError && (
        <p className="operation-error" role="alert">
          {responseError}
        </p>
      )}
      {!recoveringSource && Number.isFinite(deadline.at) && (
        <p className="operation-expiry" role="timer">
          {remaining}s remaining
        </p>
      )}
      {questions ? (
        questions.map((q) => (
          <fieldset key={q.id} className="question-fieldset">
            <legend>{q.question}</legend>
            {q.multiSelect && <p className="question-hint">Select all that apply.</p>}
            <div className="question-options">
              {q.options.map((option) => (
                <label key={option.label} className="question-option">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    disabled={locked}
                    name={`${permId}:${q.id}`}
                    checked={selections.get(q.id)?.includes(option.label) ?? false}
                    onChange={(event) => {
                      setSelections((old) =>
                        new Map(old).set(
                          q.id,
                          q.multiSelect
                            ? event.target.checked
                              ? [...(old.get(q.id) ?? []), option.label]
                              : (old.get(q.id) ?? []).filter((v) => v !== option.label)
                            : [option.label],
                        ),
                      );
                      if (!q.multiSelect) setWritten((old) => new Map(old).set(q.id, ''));
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
            </div>
            {q.allowFreeform !== false && (
              <label className="question-written">
                Your answer
                {q.isSecret ? (
                  <input
                    disabled={locked}
                    type="password"
                    autoComplete="off"
                    maxLength={4000}
                    value={written.get(q.id) ?? ''}
                    onChange={(event) => {
                      setWritten((old) => new Map(old).set(q.id, event.target.value));
                      if (!q.multiSelect) setSelections((old) => new Map(old).set(q.id, []));
                    }}
                  />
                ) : (
                  <textarea
                    disabled={locked}
                    value={written.get(q.id) ?? ''}
                    maxLength={4000}
                    rows={2}
                    placeholder="Or write your own answer…"
                    onChange={(event) => {
                      setWritten((old) => new Map(old).set(q.id, event.target.value));
                      if (!q.multiSelect) setSelections((old) => new Map(old).set(q.id, []));
                    }}
                  />
                )}
              </label>
            )}
          </fieldset>
        ))
      ) : (
        <>
          {!reviewingSource && (
            <ApprovalRequestSummary summaryOnly input={toolInput} toolName={toolName} />
          )}
          <p className="perm-banner-scope">
            {recoveringSource
              ? 'Retry only the same reviewed save. Dismiss keeps any saved item and its retained source.'
              : reviewingSource
                ? 'This saves only the reviewed source selection.'
                : (allowSessionGrant !== false && sessionGrantDescription) ||
                  (approvalScope === 'conversation'
                    ? 'This integration remains available to this conversation across reconnects and Mitzo restarts, until its sandbox is deleted or access is revoked.'
                    : allowSessionGrant === false
                      ? 'Allow once covers the displayed request.'
                      : approvalScope === 'request'
                        ? 'Allow once covers the displayed request. Allow for session keeps this approval until the session ends.'
                        : sessionSearch
                          ? 'Allow searches on this account and model until the session ends. Website access stays separate.'
                          : server
                            ? `Session allowance covers all ${server} tools.`
                            : 'Session allowance covers this tool until the task ends.')}
          </p>
        </>
      )}
    </OperationCard>
  );
}
