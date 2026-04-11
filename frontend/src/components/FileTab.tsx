import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface FileTabProps {
  filePath: string;
}

export function FileTab({ filePath }: FileTabProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setContent(null);
    setError(false);
    fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error('fetch failed');
        return r.json();
      })
      .then((data: { content: string }) => setContent(data.content))
      .catch(() => setError(true));
  }, [filePath]);

  if (error) {
    return <div className="file-tab-error">Failed to load file</div>;
  }

  if (content === null) {
    return <div className="file-tab-loading">Loading...</div>;
  }

  const isMarkdown = /\.mdx?$/i.test(filePath);

  return (
    <div className="file-tab">
      <div className="file-tab-path">{filePath}</div>
      {isMarkdown ? (
        <div className="file-tab-content viewer-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="file-tab-content file-tab-code">{content}</pre>
      )}
    </div>
  );
}
