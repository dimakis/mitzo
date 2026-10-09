import ReactMarkdown from 'react-markdown';
import { remarkPlugins, rehypePlugins } from '../lib/markdown-config';
import type { KnowledgeDocument } from '../types/knowledge';
export function KnowledgeReader({
  document,
  content,
  busy,
  onBack,
  onEdit,
}: {
  document: KnowledgeDocument;
  content: string;
  busy: boolean;
  onBack(): void;
  onEdit(): void;
}) {
  return (
    <section className="knowledge-reader">
      <div className="knowledge-editor-heading">
        <div>
          <button className="workspace-text-link" onClick={onBack}>
            ← Library
          </button>
          <p className="knowledge-reader-path">{document.path}</p>
        </div>
        <button className="btn-primary" disabled={busy} onClick={onEdit}>
          Edit
        </button>
      </div>
      <div className="knowledge-reader-meta">Accepted knowledge · {document.area}</div>
      <article className="viewer-markdown" aria-label={document.title}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
          {content}
        </ReactMarkdown>
      </article>
    </section>
  );
}
