import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';

// Register languages on demand — add new ones here.
// Each import adds ~2-10 KB gzipped; tree-shaking drops unused ones.
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import swift from 'highlight.js/lib/languages/swift';
import diff from 'highlight.js/lib/languages/diff';
import markdown from 'highlight.js/lib/languages/markdown';
import ini from 'highlight.js/lib/languages/ini';
import scss from 'highlight.js/lib/languages/scss';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('scss', scss);

import { CopyButton } from './CopyButton';

interface CodeBlockProps {
  /** The source code to display. */
  code: string;
  /** highlight.js language name (e.g. 'typescript', 'python'). Auto-detects if omitted. */
  language?: string;
  /** Optional label shown above the code (e.g. file path). */
  label?: string;
  /** Additional CSS class on the outer wrapper. */
  className?: string;
  /** Max height in px before scrolling. Default: 400. */
  maxHeight?: number;
  /** Visual variant for diff context. */
  variant?: 'default' | 'added' | 'removed';
}

export function CodeBlock({
  code,
  language,
  label,
  className,
  maxHeight = 400,
  variant = 'default',
}: CodeBlockProps) {
  const highlighted = useMemo(() => {
    if (!code) return '';
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      // Don't auto-detect — it's slow and often wrong on short snippets.
      // Just return escaped plain text.
      return escapeHtml(code);
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  const variantClass =
    variant === 'added'
      ? ' code-block-highlight--added'
      : variant === 'removed'
        ? ' code-block-highlight--removed'
        : '';

  return (
    <div className={`code-block-highlight${variantClass}${className ? ` ${className}` : ''}`}>
      {label && (
        <div className="code-block-highlight-header">
          <span className="code-block-highlight-label">{label}</span>
          {language && <span className="code-block-highlight-lang">{language}</span>}
          <CopyButton text={code} className="code-block-highlight-copy" label="Copy" />
        </div>
      )}
      {!label && <CopyButton text={code} className="code-block-highlight-copy-float" label="Copy" />}
      <pre
        className="code-block-highlight-pre hljs"
        style={{ maxHeight: `${maxHeight}px` }}
      >
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
