import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import { CopyButton } from './CopyButton';

// Register languages on demand — add new ones here.
// Each import adds ~2-10 KB gzipped; tree-shaking drops unused ones.
// IMPORTANT: Keep in sync with EXT_MAP in packages/protocol/src/language.ts
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cmake from 'highlight.js/lib/languages/cmake';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import latex from 'highlight.js/lib/languages/latex';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cmake', cmake);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('graphql', graphql);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('latex', latex);
hljs.registerLanguage('less', less);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('makefile', makefile);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('perl', perl);
hljs.registerLanguage('php', php);
hljs.registerLanguage('protobuf', protobuf);
hljs.registerLanguage('python', python);
hljs.registerLanguage('r', r);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

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
  /** Callback when user clicks the pop-out button. */
  onPopOut?: () => void;
}

export function CodeBlock({
  code,
  language,
  label,
  className,
  maxHeight = 400,
  variant = 'default',
  onPopOut,
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
          {onPopOut && (
            <button
              className="code-block-highlight-popout"
              onClick={onPopOut}
              aria-label="Open in viewer"
              title="Open in viewer"
            >
              ↗
            </button>
          )}
        </div>
      )}
      {!label && (
        <div className="code-block-highlight-float-actions">
          <CopyButton text={code} className="code-block-highlight-copy-float" label="Copy" />
          {onPopOut && (
            <button
              className="code-block-highlight-popout-float"
              onClick={onPopOut}
              aria-label="Open in viewer"
              title="Open in viewer"
            >
              ↗
            </button>
          )}
        </div>
      )}
      <pre className="code-block-highlight-pre hljs" style={{ maxHeight: `${maxHeight}px` }}>
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
