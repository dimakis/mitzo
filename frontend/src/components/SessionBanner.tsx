import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
      <button className="session-banner-section-button" onClick={toggle} aria-expanded={open}>
        <span className="session-banner-chevron-inline">
          <UiIcon name={open ? 'down' : 'forward'} size={16} />
        </span>
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
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setShowModal(false);
      }
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [showModal]);

  // Reset expand states when context identity changes (e.g. session switch)
  const contextKey =
    (bootContext?.receipt?.payloadHash ?? '') +
    ':' +
    (bootContext?.tokenCount ?? '') +
    ':' +
    (bootContext?.sourceCount ?? '') +
    ':' +
    (bootContext?.sources[0]?.path ?? '') +
    '|' +
    (sessionContext ?? '');
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
        <button
          className="session-banner-header"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
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
          <span className="session-banner-chevron">
            <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
          </span>
        </button>

        <MotionPresence open={expanded} kind="disclosure">
          <div className="session-banner-body">
            {/* Session context (Telos item / inbox) */}
            {sessionContext && (
              <div className="session-banner-context">
                <div className="session-banner-label">Session Context</div>
                <pre className="session-banner-context-text">{sessionContext}</pre>
              </div>
            )}

            {bootContext?.receipt && (
              <p className="session-banner-sub-label">
                {bootContext.receipt.status === 'accepted'
                  ? 'Accepted by provider'
                  : 'Prepared · awaiting provider acknowledgment'}
              </p>
            )}
            {/* Boot context details */}
            {bootContext && (
              <div className="session-banner-boot">
                <div className="session-banner-boot-row">
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
                    <span className="session-banner-chevron-inline">
                      <UiIcon name={showBootDetails ? 'down' : 'forward'} size={16} />
                    </span>
                  </div>
                  {bootContext.fullMarkdown && (
                    <button
                      className="session-banner-view-full"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowModal(true);
                      }}
                      title="View full markdown"
                      aria-label="View full markdown"
                    >
                      <UiIcon name="file" size={16} />
                    </button>
                  )}
                </div>

                <MotionPresence open={showBootDetails} kind="disclosure">
                  <div className="session-banner-boot-content">
                    {bootContext.receipt && (
                      <div className="session-banner-receipt">
                        <p>
                          Profile {bootContext.receipt.profileId} · revision{' '}
                          {bootContext.receipt.profileRevision}
                        </p>
                        <p>
                          Compiler: <code>{bootContext.receipt.compilerRevision}</code>
                        </p>
                        <p>
                          Context reference: <code>{bootContext.receipt.payloadHash}</code>
                        </p>
                        <p>
                          Recipe reference: <code>{bootContext.receipt.recipeHash}</code>
                        </p>
                        {bootContext.receipt.provenance && (
                          <>
                            <div className="session-banner-sub-label">Pinned packs</div>
                            {bootContext.receipt.provenance.packs.map((pack) => (
                              <div key={`${pack.id}:${pack.revision}`}>
                                <p>
                                  {pack.id} · revision {pack.revision}
                                </p>
                                <code>{pack.hash}</code>
                              </div>
                            ))}
                            <div className="session-banner-sub-label">
                              Accepted source revisions
                            </div>
                            {bootContext.receipt.provenance.documents.map((document) => (
                              <div key={`${document.path}:${document.revision}`}>
                                <p>
                                  {document.path} · {document.storeId}
                                </p>
                                <code>{document.revision}</code>
                                <p>
                                  Content hash: <code>{document.contentHash}</code>
                                </p>
                              </div>
                            ))}
                            <div className="session-banner-sub-label">Omitted sections</div>
                            {bootContext.receipt.provenance.omissions.length ? (
                              bootContext.receipt.provenance.omissions.map((section, index) => (
                                <p key={index}>
                                  {section.path} · {section.heading} · {section.reason}
                                </p>
                              ))
                            ) : (
                              <p>No sections omitted.</p>
                            )}
                          </>
                        )}
                      </div>
                    )}
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
                          aria-expanded={showTrimmed}
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowTrimmed((t) => !t);
                          }}
                        >
                          {bootContext.trimmed.length} section
                          {bootContext.trimmed.length !== 1 ? 's' : ''} trimmed
                          <span className="session-banner-chevron-inline">
                            <UiIcon name={showTrimmed ? 'down' : 'forward'} size={16} />
                          </span>
                        </button>
                        {showTrimmed &&
                          bootContext.trimmed.map((section, idx) => (
                            <SectionRow key={idx} section={section} dimmed />
                          ))}
                      </>
                    )}
                  </div>
                </MotionPresence>
              </div>
            )}
          </div>
        </MotionPresence>
      </div>

      {showModal &&
        bootContext?.fullMarkdown &&
        createPortal(
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
                <button
                  onClick={() => setShowModal(false)}
                  className="boot-context-modal-close"
                  aria-label="Close boot context"
                >
                  <UiIcon name="close" size={16} />
                </button>
              </div>
              <pre className="boot-context-modal-content">{bootContext.fullMarkdown}</pre>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
