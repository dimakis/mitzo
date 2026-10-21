import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from './UiIcon';
import { useTelosSourceReview } from './TelosSourceReview';
import { sessionApprovalServer, type QuestionAnswers, type UserQuestion } from '@mitzo/protocol';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';
interface Props {
  permId: string;
  sessionId?: string;
  reviewKind?: 'telos_source';
  recoveryOnly?: true;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
  approvalScope?: 'session' | 'conversation' | 'request';
  allowSessionGrant?: boolean;
  sessionGrantDescription?: string;
  responseError?: string;
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

export function PermissionBanner({
  permId,
  sessionId,
  reviewKind,
  recoveryOnly,
  toolName,
  toolInput,
  title,
  description,
  displayName,
  tier,
  approvalScope,
  allowSessionGrant,
  responseError,
  sessionGrantDescription,
  questions,
  expiresAt,
  onRespond,
  onExpire,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (responseError && submitting) setSubmitting(false);
  }, [responseError, submitting]);
  const respond: Props['onRespond'] = (id, decision, tool, answers) => {
    setSubmitting(true);
    if (answers) onRespond(id, decision, tool, answers);
    else onRespond(id, decision, tool);
  };
  const [selections, setSelections] = useState<Map<string, string[]>>(() => new Map());
  const [written, setWritten] = useState<Map<string, string>>(() => new Map());
  const deadline = useMemo(
    () => ({ id: permId, at: expiresAt ?? Date.now() + 120_000 }),
    [permId, expiresAt],
  );
  const sourceReview = useTelosSourceReview({
    enabled: reviewKind === 'telos_source',
    permId,
    sessionId,
    expiresAt: deadline.at,
    recoveryOnly: reviewKind === 'telos_source' && recoveryOnly === true,
  });
  const reviewingSource = reviewKind === 'telos_source';
  const recoveringSource = reviewingSource && recoveryOnly === true;
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000)),
  );
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  useEffect(() => {
    if (recoveringSource) return;
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
    setSubmitting(false);
    setSelections(new Map());
    setWritten(new Map());
  }, [permId]);

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
  const heading = questions
    ? 'A question for you'
    : reviewingSource
      ? recoveringSource
        ? 'Recover Telos save'
        : 'Save to Telos'
      : title || displayName || toolName;
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
  // Local expiry hides this card; the server owns timeout resolution.
  // Keep retryable errors visible only while the request remains valid.
  if (!recoveringSource && (remaining === 0 || deadline.at <= Date.now())) return null;

  return createPortal(
    <section
      className={`perm-banner perm-banner--visible${tierClass}`}
      aria-busy={submitting || sourceReview.saving}
      aria-label={
        questions ? 'Agent questions' : recoveringSource ? 'Save recovery' : 'Approval required'
      }
    >
      <div className="perm-banner-heading">
        <span className="perm-banner-eyebrow">
          {questions
            ? 'Your input is needed'
            : recoveringSource
              ? 'Save recovery'
              : 'Approval required'}
        </span>
        {!recoveringSource && (
          <span className="perm-banner-timer" role="timer">
            {remaining > 0 ? `${remaining}s remaining` : 'Request expired'}
          </span>
        )}
      </div>
      <div className="perm-banner-info">
        <h2 className="perm-banner-tool">{heading}</h2>
        {!questions && !reviewingSource && tier && (
          <span className={`perm-banner-tier perm-banner-tier--${tier}`}>{TIER_LABELS[tier]}</span>
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
            {description && <p className="perm-banner-desc">{description}</p>}
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
            {(toolInput || reviewingSource) && (
              <details key={permId} className="perm-banner-details" open>
                <summary>
                  <UiIcon name="forward" size={16} />
                  Request details
                </summary>
                {!reviewingSource && <pre className="perm-banner-input">{toolInput}</pre>}
                {sourceReview.content}
              </details>
            )}
          </>
        )}
      </div>
      <div
        className={`perm-banner-actions${questions ? ' perm-banner-actions--questions' : ''}${reviewingSource || (allowSessionGrant === false && !questions) ? ' perm-banner-actions--source' : ''}`}
      >
        {(submitting || sourceReview.saving) && (
          <p className="perm-banner-scope perm-banner-submitting" role="status">
            Sending response…
          </p>
        )}
        {responseError && (
          <p className="perm-banner-response-error" role="alert">
            {responseError}
          </p>
        )}
        {questions ? (
          <button
            className="perm-banner-btn perm-banner-btn--once"
            disabled={submitting || !complete || remaining === 0}
            onClick={() => respond(permId, 'once', toolName, answers)}
          >
            Send answer
          </button>
        ) : (
          <>
            <button
              className="perm-banner-btn perm-banner-btn--once"
              aria-label={
                recoveringSource
                  ? 'Retry same save'
                  : approvalScope === 'conversation'
                    ? 'Grant to conversation'
                    : 'Allow Once'
              }
              disabled={
                submitting ||
                (!recoveringSource && remaining === 0) ||
                (reviewingSource && !sourceReview.ready)
              }
              onClick={() =>
                reviewingSource ? void sourceReview.approve() : respond(permId, 'once', toolName)
              }
            >
              {recoveringSource
                ? 'Retry same save'
                : approvalScope === 'conversation'
                  ? 'Grant'
                  : 'Once'}
            </button>
            {!reviewingSource && allowSessionGrant !== false && (
              <button
                className="perm-banner-btn perm-banner-btn--always"
                aria-label={sessionSearch ? 'Allow searches for this session' : 'Allow for session'}
                disabled={submitting || remaining === 0}
                onClick={() => respond(permId, 'always', toolName)}
              >
                Session
              </button>
            )}
          </>
        )}
        <button
          className="perm-banner-btn perm-banner-btn--deny"
          disabled={submitting || sourceReview.saving || (!recoveringSource && sourceReview.saved)}
          onClick={() => respond(permId, 'deny', toolName)}
        >
          {questions ? 'Cancel' : recoveringSource ? 'Dismiss' : 'Deny'}
        </button>
      </div>
    </section>,
    document.body,
  );
}
