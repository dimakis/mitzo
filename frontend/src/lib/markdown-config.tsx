import React from 'react';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { MermaidBlock } from '../components/MermaidBlock';
import { extractText } from './extractText';

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'],
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
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
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement(child)) {
      const className = (child.props as Record<string, unknown>)?.className;
      if (typeof className === 'string' && /language-mermaid/.test(className)) {
        const text = extractText(children);
        return <MermaidBlock code={text} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
};
