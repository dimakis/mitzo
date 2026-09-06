import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { MermaidBlock } from '../components/MermaidBlock';
import { getMermaidCode } from './mermaid-detect';

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
    // Only allow language-* classes (set by rehype-highlight) — not arbitrary classNames
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/]],
  },
};

export const remarkPlugins: PluggableList = [remarkGfm];
export const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

export const markdownComponents: Components = {
  table: ({ children, ...props }) => (
    <div className="table-scroll-wrapper">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: ({ children, ...props }) => {
    const mermaidCode = getMermaidCode(children);
    if (mermaidCode !== null) return <MermaidBlock code={mermaidCode} />;
    return <pre {...props}>{children}</pre>;
  },
};
