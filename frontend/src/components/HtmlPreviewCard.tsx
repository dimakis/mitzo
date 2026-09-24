import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';
import { artifactApiUrl, artifactViewerUrl } from '../lib/file-paths';
import { HtmlPreview } from './HtmlPreview';

interface Props {
  filePath: string;
  sessionId?: string;
}

export function HtmlPreviewCard({ filePath, sessionId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = location.pathname + location.search;
  const fileName = filePath.split('/').pop() || filePath;

  const handleToggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && content === null && !loading) {
      setError(null);
      setLoading(true);
      try {
        const res = await apiFetch(artifactApiUrl('read', filePath, sessionId));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        setContent(data.content);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="html-preview-card">
      <div className="html-preview-card-header">
        <button className="html-preview-card-toggle" onClick={handleToggle}>
          <span className="html-preview-card-icon">HTML</span>
          <span className="html-preview-card-name">{fileName}</span>
          <span className="html-preview-card-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        </button>
        <button
          className="html-preview-card-open"
          onClick={() => navigate(artifactViewerUrl(filePath, currentPath, sessionId))}
        >
          Open
        </button>
      </div>
      {expanded && (
        <div className="html-preview-card-content">
          {loading && <p className="html-preview-card-status">Loading...</p>}
          {error && (
            <p className="html-preview-card-status html-preview-card-status--error">{error}</p>
          )}
          {content !== null && (
            <HtmlPreview
              html={content}
              title={`${fileName} preview`}
              className="html-preview-card-frame"
            />
          )}
        </div>
      )}
    </div>
  );
}
