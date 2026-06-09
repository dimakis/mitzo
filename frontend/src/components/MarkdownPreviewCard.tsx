import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins, markdownComponents } from '../lib/markdown-config';
import { useNavigate, useLocation } from 'react-router-dom';
import { apiFetch } from '../lib/api-fetch';

interface Props {
  filePath: string;
}

export function MarkdownPreviewCard({ filePath }: Props) {
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
        const res = await apiFetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
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
        <button
          className="md-preview-card-open"
          onClick={() =>
            navigate(
              `/files?path=${encodeURIComponent(filePath)}&from=${encodeURIComponent(currentPath)}`,
            )
          }
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
                components={markdownComponents}
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
