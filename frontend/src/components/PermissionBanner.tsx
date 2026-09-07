import { useState, useEffect, useRef, useMemo } from 'react';
import type { QuestionAnswers, UserQuestion } from '@mitzo/protocol';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';
interface Props {
  permId: string;
  toolName: string;
  toolInput: string;
  title?: string;
  description?: string;
  displayName?: string;
  tier?: ToolTier;
  expiresAt?: number;
  questions?: UserQuestion[];
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
  toolName,
  toolInput,
  title,
  description,
  displayName,
  tier,
  questions,
  expiresAt,
  onRespond,
}: Props) {
  const [selections, setSelections] = useState<QuestionAnswers>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const deadline = useMemo(
    () => ({ id: permId, at: expiresAt ?? Date.now() + 120_000 }),
    [permId, expiresAt],
  );
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000)),
  );
  const respondRef = useRef(onRespond);
  respondRef.current = onRespond;
  useEffect(() => {
    let expired = false;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline.at - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && !expired) {
        expired = true;
        respondRef.current(permId, 'deny', toolName);
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [deadline, permId, toolName]);
  useEffect(() => {
    setSelections({});
    setWritten({});
  }, [permId]);

  const answers = Object.fromEntries(
    (questions ?? []).map((q) => [
      q.id,
      [...(selections[q.id] ?? []), ...(written[q.id]?.trim() ? [written[q.id].trim()] : [])],
    ]),
  );
  const complete = questions?.every((q) => answers[q.id].length > 0);
  const heading = questions ? 'A question for you' : title || displayName || toolName;
  const server = toolName.startsWith('mcp__') ? toolName.split('__')[1] : undefined;
  const tierClass =
    tier === 'elevated'
      ? ' perm-banner--elevated'
      : tier === 'unknown'
        ? ' perm-banner--unknown'
        : '';
  return (
    <section
      className={`perm-banner perm-banner--visible${tierClass}`}
      aria-label={questions ? 'Agent questions' : 'Approval required'}
    >
      <div className="perm-banner-heading">
        <span className="perm-banner-eyebrow">
          {questions ? 'Your input is needed' : 'Approval required'}
        </span>
        <span className="perm-banner-timer" role="timer">
          {remaining > 0 ? `${remaining}s remaining` : 'Request expired'}
        </span>
      </div>
      <div className="perm-banner-info">
        <h2 className="perm-banner-tool">{heading}</h2>
        {!questions && tier && (
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
                      checked={selections[q.id]?.includes(option.label) ?? false}
                      onChange={(event) => {
                        setSelections((old) => ({
                          ...old,
                          [q.id]: q.multiSelect
                            ? event.target.checked
                              ? [...(old[q.id] ?? []), option.label]
                              : (old[q.id] ?? []).filter((v) => v !== option.label)
                            : [option.label],
                        }));
                        if (!q.multiSelect) setWritten((old) => ({ ...old, [q.id]: '' }));
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
              </div>
              <label className="question-written">
                Your answer
                <textarea
                  value={written[q.id] ?? ''}
                  maxLength={4000}
                  rows={2}
                  placeholder="Or write your own answer…"
                  onChange={(event) => {
                    setWritten((old) => ({ ...old, [q.id]: event.target.value }));
                    if (!q.multiSelect) setSelections((old) => ({ ...old, [q.id]: [] }));
                  }}
                />
              </label>
            </fieldset>
          ))
        ) : (
          <>
            {description && <p className="perm-banner-desc">{description}</p>}
            {toolInput && <pre className="perm-banner-input">{toolInput}</pre>}
            <p className="perm-banner-scope">
              {server
                ? `Session allowance covers all ${server} tools.`
                : 'Session allowance covers this tool until the task ends.'}
            </p>
          </>
        )}
      </div>
      <div className="perm-banner-actions">
        {questions ? (
          <button
            className="perm-banner-btn perm-banner-btn--once"
            disabled={!complete || remaining === 0}
            onClick={() => onRespond(permId, 'once', toolName, answers)}
          >
            Send answer
          </button>
        ) : (
          <>
            <button
              className="perm-banner-btn perm-banner-btn--once"
              disabled={remaining === 0}
              onClick={() => onRespond(permId, 'once', toolName)}
            >
              Allow Once
            </button>
            <button
              className="perm-banner-btn perm-banner-btn--always"
              disabled={remaining === 0}
              onClick={() => onRespond(permId, 'always', toolName)}
            >
              Allow for session
            </button>
          </>
        )}
        <button
          className="perm-banner-btn perm-banner-btn--deny"
          onClick={() => onRespond(permId, 'deny', toolName)}
        >
          {questions ? 'Cancel' : 'Deny'}
        </button>
      </div>
    </section>
  );
}
