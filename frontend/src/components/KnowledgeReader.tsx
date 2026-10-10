import { UiIcon } from './UiIcon';
import ReactMarkdown from 'react-markdown';
import {
  remarkPlugins,
  rehypePlugins,
  markdownComponents,
  artifactUrlTransform,
} from '../lib/markdown-config';
import { linkedArtifactPath, FILE_SCHEME } from '../lib/file-paths';
import type { KnowledgeDocument } from '../types/knowledge';
export function KnowledgeReader({
  document,
  content,
  busy,
  onBack,
  onEdit,
  workingCopy,
  documents = [],
  onOpen,
}: {
  document: KnowledgeDocument;
  content: string;
  busy: boolean;
  workingCopy?: boolean;
  documents?: KnowledgeDocument[];
  onOpen?(document: KnowledgeDocument): void;
  onBack(): void;
  onEdit(): void;
}) {
  return (
    <section className="knowledge-reader">
      <div className="knowledge-editor-heading">
        <div>
          <button className="workspace-text-link" onClick={onBack}>
            <UiIcon name="back" size={16} /> Library
          </button>
          <p className="knowledge-reader-path">{document.path}</p>
        </div>
        <button className="btn-primary" disabled={busy} onClick={onEdit}>
          Edit
        </button>
      </div>
      <div className="knowledge-reader-meta">
        {workingCopy ? 'Working copy' : 'Accepted knowledge'} · {document.area}
      </div>
      <article className="viewer-markdown" aria-label={document.title}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={artifactUrlTransform}
          components={{
            ...markdownComponents,
            a: ({ href, children, title }) => {
              if (!href || href.startsWith(FILE_SCHEME)) return <span>{children}</span>;
              if (/^https?:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:'))
                return (
                  <a href={href} title={title}>
                    {children}
                  </a>
                );
              const path = linkedArtifactPath(href, document.path);
              const target =
                path && !path.startsWith('/') && !path.startsWith('~')
                  ? documents.find((item) => item.path === path)
                  : undefined;
              if (!target || !onOpen) return <span>{children}</span>;
              return (
                <a
                  href={`#knowledge-${encodeURIComponent(target.path)}`}
                  title={title}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpen(target);
                  }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </section>
  );
}
