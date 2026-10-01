import type { ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import { getMermaidCode } from '../lib/mermaid-detect';
import { extractText } from '../lib/extractText';
import { MermaidBlock } from './MermaidBlock';
import { CopyButton } from './CopyButton';

export function MarkdownCodeBlock({
  children,
  node: _node,
  ...props
}: ComponentProps<'pre'> & ExtraProps) {
  const code = getMermaidCode(children);
  if (code !== null) return <MermaidBlock code={code} />;
  return (
    <div className="code-block-wrapper">
      <pre {...props}>{children}</pre>
      <CopyButton text={extractText(children)} className="code-block-copy" label="Copy code" />
    </div>
  );
}
