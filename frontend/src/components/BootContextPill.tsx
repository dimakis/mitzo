import { useState } from 'react';
import type { BootContextMeta, SectionMeta } from '@mitzo/client';

interface Props {
  context: BootContextMeta;
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
      className={`boot-context-pill-section-row ${dimmed ? 'boot-context-pill-section-row--dimmed' : ''}`}
    >
      <button className="boot-context-pill-section-button" onClick={toggle}>
        <span className="boot-context-pill-chevron-inline">{open ? '\u25BE' : '\u25B8'}</span>
        <span className="boot-context-pill-section-heading">{section.heading}</span>
        <span className="boot-context-pill-section-tokens">{section.tokens}t</span>
      </button>
      {open && section.content && (
        <pre className="boot-context-pill-section-content">{section.content}</pre>
      )}
    </div>
  );
}

export function BootContextPill({ context }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showTrimmed, setShowTrimmed] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const isContexgin = context.source === 'contexgin';
  const dotClass = isContexgin ? 'boot-context-pill-dot--ok' : 'boot-context-pill-dot--warn';
  const tokenLabel =
    context.tokenCount >= 1000
      ? `${(context.tokenCount / 1000).toFixed(1)}k`
      : String(context.tokenCount);
  const budgetLabel =
    context.tokenBudget >= 1000
      ? `${(context.tokenBudget / 1000).toFixed(1)}k`
      : String(context.tokenBudget);
  const label = `${context.sourceCount} sources \u00b7 ${tokenLabel} / ${budgetLabel}`;

  return (
    <div className="boot-context-pill">
      <button className="boot-context-pill-header" onClick={() => setExpanded((e) => !e)}>
        <span className={`boot-context-pill-dot ${dotClass}`} />
        <span className="boot-context-pill-label">{label}</span>
        <span className="boot-context-pill-engine">{isContexgin ? 'ContexGin' : 'Fallback'}</span>
        <span className="boot-context-pill-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        {context.fullMarkdown && (
          <button
            className="boot-context-pill-view-full"
            onClick={(e) => {
              e.stopPropagation();
              setShowModal(true);
            }}
            title="View full markdown"
          >
            ⎘
          </button>
        )}
      </button>
      {expanded && (
        <div className="boot-context-pill-content">
          <div className="boot-context-pill-section-label">Sources</div>
          {context.sources.map((src, idx) => (
            <div key={idx} className="boot-context-pill-source-row">
              <span className={`boot-context-pill-kind boot-context-pill-kind--${src.kind}`}>
                {KIND_LABELS[src.kind] ?? src.kind}
              </span>
              <span className="boot-context-pill-source-path">{src.path}</span>
            </div>
          ))}

          {context.included.length > 0 && (
            <>
              <div className="boot-context-pill-section-label">
                Included ({context.included.length})
              </div>
              {context.included.map((section, idx) => (
                <SectionRow key={idx} section={section} />
              ))}
            </>
          )}

          {context.trimmed.length > 0 && (
            <>
              <button
                className="boot-context-pill-trimmed-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowTrimmed((t) => !t);
                }}
              >
                {context.trimmed.length} section{context.trimmed.length !== 1 ? 's' : ''} trimmed
                <span className="boot-context-pill-chevron-inline">
                  {showTrimmed ? '\u25BE' : '\u25B8'}
                </span>
              </button>
              {showTrimmed &&
                context.trimmed.map((section, idx) => (
                  <SectionRow key={idx} section={section} dimmed />
                ))}
            </>
          )}
        </div>
      )}

      {showModal && context.fullMarkdown && (
        <div
          className="boot-context-modal-overlay"
          onClick={() => setShowModal(false)}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="boot-context-modal" onClick={(e) => e.stopPropagation()}>
            <div className="boot-context-modal-header">
              <h3>Boot Context (Full Markdown)</h3>
              <button onClick={() => setShowModal(false)} className="boot-context-modal-close">
                ✕
              </button>
            </div>
            <pre className="boot-context-modal-content">{context.fullMarkdown}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
