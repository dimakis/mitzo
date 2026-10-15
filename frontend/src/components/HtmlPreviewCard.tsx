import { UiIcon } from './UiIcon';
import { useEffect, useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';
import { artifactApiUrl, artifactViewerUrl } from '../lib/file-paths';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { HtmlPreview } from './HtmlPreview';

interface Props {
  filePath: string;
  sessionId?: string;
}

export function HtmlPreviewCard(props: Props) {
  // A new artifact must never inherit another file's content or a pending read.
  return (
    <HtmlPreviewCardContent key={JSON.stringify([props.sessionId, props.filePath])} {...props} />
  );
}

function HtmlPreviewCardContent({ filePath, sessionId }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [document, setDocument] = useState<{ content: string; path: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { ref, present } = useMotionPresence(expanded, 'disclosure', false);
  const contentId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname + location.search;
  const fileName = filePath.split('/').pop() || filePath;

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await apiFetch(artifactApiUrl('read', filePath, sessionId));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data: unknown = await res.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('content' in data) ||
          typeof data.content !== 'string'
        )
          throw new Error('The file did not contain an HTML document.');
        const path =
          'path' in data && typeof data.path === 'string' && data.path ? data.path : filePath;
        if (active) setDocument({ content: data.content, path });
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [filePath, sessionId, attempt]);

  return (
    <div className="html-preview-card">
      <div className="html-preview-card-header">
        <button
          type="button"
          className="html-preview-card-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={contentId}
        >
          <span className="html-preview-card-icon">HTML</span>
          <span className="html-preview-card-name">{fileName}</span>
          <span className="html-preview-card-chevron">
            <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
          </span>
        </button>
        <button
          type="button"
          className="html-preview-card-open"
          onClick={() =>
            navigate(artifactViewerUrl(document?.path ?? filePath, currentPath, sessionId))
          }
        >
          Open
        </button>
      </div>
      <div
        id={contentId}
        ref={ref}
        hidden={!present}
        inert={!expanded}
        aria-hidden={!expanded || undefined}
        className="html-preview-card-content"
      >
        {loading && (
          <p className="html-preview-card-status" role="status">
            Loading preview…
          </p>
        )}
        {error && (
          <div className="html-preview-card-status html-preview-card-status--error">
            <p role="alert">{error}</p>
            <button
              type="button"
              className="html-preview-card-open"
              onClick={() => {
                setError(null);
                setLoading(true);
                setAttempt((value) => value + 1);
              }}
            >
              Retry preview
            </button>
          </div>
        )}
        {document !== null && (
          <HtmlPreview
            html={document.content}
            title={`${fileName} preview`}
            className="html-preview-card-frame"
          />
        )}
      </div>
    </div>
  );
}
