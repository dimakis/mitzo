import { ShareButton } from './ShareButton';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  remarkPlugins,
  rehypePlugins,
  artifactMarkdownComponents,
  artifactUrlTransform,
} from '../lib/markdown-config';
import { useNavigate, useLocation } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';
import { artifactApiUrl, artifactViewerUrl } from '../lib/file-paths';

interface Props {
  filePath: string;
  sessionId?: string;
}

export function MarkdownPreviewCard({ filePath, sessionId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [resolvedFile, setResolvedFile] = useState<{
    source: string;
    sessionId?: string;
    path: string;
  } | null>(null);
  const openedPath =
    resolvedFile?.source === filePath && resolvedFile.sessionId === sessionId
      ? resolvedFile.path
      : filePath;
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
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `Failed to load file (${res.status})`);
        }
        const data = await res.json();
        if (typeof data.path === 'string' && data.path)
          setResolvedFile({ source: filePath, sessionId, path: data.path });
        setContent(data.content);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="md-preview-card">
      <div className="md-preview-card-header">
        <button className="md-preview-card-toggle" onClick={handleToggle}>
          <span className="md-preview-card-icon">MD</span>
          <span className="md-preview-card-name">{fileName}</span>
          <span className="md-preview-card-chevron">{expanded ? '\u25BE' : '\u25B8'}</span>
        </button>
        <ShareButton filePath={openedPath} sessionId={sessionId} className="share-btn--visible" />
        <button
          className="md-preview-card-open"
          onClick={() => navigate(artifactViewerUrl(openedPath, currentPath, sessionId))}
        >
          Open
        </button>
      </div>
      {expanded && (
        <div className="md-preview-card-content">
          {loading && <p className="md-preview-card-status">Loading...</p>}
          {error && <p className="md-preview-card-status md-preview-card-status--error">{error}</p>}
          {content !== null && (
            <div className="md-preview-card-body">
              <ReactMarkdown
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                urlTransform={artifactUrlTransform}
                components={artifactMarkdownComponents(
                  openedPath,
                  sessionId,
                  currentPath,
                  navigate,
                )}
              >
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
