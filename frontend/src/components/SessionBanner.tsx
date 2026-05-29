import { useState, useEffect } from 'react';
import type { BootContextMeta, SectionMeta } from '@mitzo/client';

interface Props {
  bootContext?: BootContextMeta | null;
  sessionContext?: string | null;
}

const KIND_LABELS: Record<string, string> = {
  constitution: 'const',
  profile: 'profile',
  memory: 'mem',
  service: 'svc',
  reference: 'ref',
};

function SectionRow({ section, dimmed }: { section: SectionMeta; dimmed?: boolean }) {
  const [open, setOpen] = useState(false);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((o) => !o);
  };

  return (
    <div
      className={`session-banner-section-row ${dimmed ? 'session-banner-section-row--dimmed' : ''}`}
    >
      <button className="session-banner-section-button" onClick={toggle}>
        <span className="session-banner-chevron-inline">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="session-banner-section-heading">{section.heading}</span>
        <span className="session-banner-section-tokens">{section.tokens}t</span>
      </button>
      {open && section.content && (
        <pre className="session-banner-section-content">{section.content}</pre>
      )}
    </div>
  );
}

/** Truncate session context to first line for the collapsed summary */
function summaryLine(text: string): string {
  const first = text.split('\n').find((l) => l.trim());
  if (!first) return text.slice(0, 80);
  return first.length > 80 ? first.slice(0, 77) + '...' : first;
}

export function SessionBanner({ bootContext, sessionContext }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showBootDetails, setShowBootDetails] = useState(false);
  const [showTrimmed, setShowTrimmed] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // Escape key handler for modal
  useEffect(() => {
    if (!showModal) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowModal(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showModal]);

  // Reset expand states when context identity changes (e.g. session switch)
  const contextKey = (bootContext?.tokenCount ?? '') + '|' + (sessionContext ?? '');
  useEffect(() => {
    setExpanded(false);
    setShowBootDetails(false);
    setShowTrimmed(false);
    setShowModal(false);
  }, [contextKey]);

  if (!bootContext && !sessionContext) return null;

  const isContexgin = bootContext?.source === 'contexgin';
  const dotClass = isContexgin ? 'session-banner-dot--ok' : 'session-banner-dot--warn';

  const tokenLabel = bootContext
    ? bootContext.tokenCount >= 1000
      ? `${(bootContext.tokenCount / 1000).toFixed(1)}k`
      : String(bootContext.tokenCount)
    : null;

  const budgetLabel = bootContext
    ? bootContext.tokenBudget >= 1000
      ? `${(bootContext.tokenBudget / 1000).toFixed(1)}k`
      : String(bootContext.tokenBudget)
    : null;

  return (
    <>
      <div className="session-banner">
        <button className="session-banner-header" onClick={() => setExpanded((e) => !e)}>
          {bootContext && <span className={`session-banner-dot ${dotClass}`} />}
          <span className="session-banner-summary">
            {bootContext && (
              <span className="session-banner-meta">
                {bootContext.sourceCount} sources · {tokenLabel}
                {budgetLabel ? `/${budgetLabel}` : ''}
              </span>
            )}
            {sessionContext && (
              <span className="session-banner-context-hint">{summaryLine(sessionContext)}</span>
            )}
          </span>
          <span className="session-banner-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        </button>

        {expanded && (
          <div className="session-banner-body">
            {/* Session context (Telos item / inbox) */}
            {sessionContext && (
              <div className="session-banner-context">
                <div className="session-banner-label">Session Context</div>
                <pre className="session-banner-context-text">{sessionContext}</pre>
              </div>
            )}

            {/* Boot context details */}
            {bootContext && (
              <div className="session-banner-boot">
                <div
                  className="session-banner-boot-toggle"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowBootDetails((d) => !d);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setShowBootDetails((d) => !d);
                    }
                  }}
                >
                  <span className="session-banner-label">
                    Boot Context ({isContexgin ? 'ContexGin' : 'Fallback'})
                  </span>
                  {bootContext.fullMarkdown && (
                    <button
                      className="session-banner-view-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModal(true);
                      }}
                      title="View full markdown"
                    >
                      ⧉
                    </button>
                  )}
                  <span className="session-banner-chevron-inline">
                    {showBootDetails ? '\u25BE' : '\u25B8'}
                  </span>
                </div>

                {showBootDetails && (
                  <div className="session-banner-boot-content">
                    <div className="session-banner-sub-label">Sources</div>
                    {bootContext.sources.map((src, idx) => (
                      <div key={idx} className="session-banner-source-row">
                        <span className={`session-banner-kind session-banner-kind--${src.kind}`}>
                          {KIND_LABELS[src.kind] ?? src.kind}
                        </span>
                        <span className="session-banner-source-path">{src.path}</span>
                      </div>
                    ))}

                    {bootContext.included.length > 0 && (
                      <>
                        <div className="session-banner-sub-label">
                          Included ({bootContext.included.length})
                        </div>
                        {bootContext.included.map((section, idx) => (
                          <SectionRow key={idx} section={section} />
                        ))}
                      </>
                    )}

                    {bootContext.trimmed.length > 0 && (
                      <>
                        <button
                          className="session-banner-trimmed-toggle"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowTrimmed((t) => !t);
                          }}
                        >
                          {bootContext.trimmed.length} section
                          {bootContext.trimmed.length !== 1 ? 's' : ''} trimmed
                          <span className="session-banner-chevron-inline">
                            {showTrimmed ? '\u25BE' : '\u25B8'}
                          </span>
                        </button>
                        {showTrimmed &&
                          bootContext.trimmed.map((section, idx) => (
                            <SectionRow key={idx} section={section} dimmed />
                          ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && bootContext?.fullMarkdown && (
        <div
          className="boot-context-modal-overlay"
          onClick={() => setShowModal(false)}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div
            className="boot-context-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Boot context full markdown"
          >
            <div className="boot-context-modal-header">
              <h3>Boot Context (Full Markdown)</h3>
              <button onClick={() => setShowModal(false)} className="boot-context-modal-close">
                ✕
              </button>
            </div>
            <pre className="boot-context-modal-content">{bootContext.fullMarkdown}</pre>
          </div>
        </div>
      )}
    </>
  );
}
