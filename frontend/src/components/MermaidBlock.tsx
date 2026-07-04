import { useEffect, useId, useState } from 'react';
import { CopyButton } from './CopyButton';

let mermaidInitialized = false;

/** Exported for test cleanup only. */
export function _resetMermaidInit() {
  mermaidInitialized = false;
}

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const instanceId = useId();
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${instanceId.replace(/:/g, '')}`;

    async function render() {
      try {
        // Dynamic import keeps mermaid (~1MB+ with d3/katex/cytoscape) out of
        // the main bundle — only loaded when a mermaid diagram is encountered.
        const { default: mermaid } = await import('mermaid');
        if (!mermaidInitialized) {
          mermaidInitialized = true;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'dark',
            themeVariables: {
              darkMode: true,
              background: '#1e1e2e',
              primaryColor: '#7c3aed',
              primaryTextColor: '#e2e8f0',
              primaryBorderColor: '#6366f1',
              lineColor: '#94a3b8',
              secondaryColor: '#374151',
              tertiaryColor: '#1f2937',
              noteBkgColor: '#374151',
              noteTextColor: '#e2e8f0',
              fontFamily: 'inherit',
            },
          });
        }
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('Invalid diagram');
          setSvg(null);
          document.getElementById(`d${id}`)?.remove();
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [code, instanceId]);

  if (error) {
    return (
      <div className="code-block-wrapper">
        <pre>
          <code>{code}</code>
        </pre>
        <CopyButton text={code} className="code-block-copy" label="Copy code" />
      </div>
    );
  }

  if (!svg) return null;

  return (
    <div className="mermaid-block">
      <div className="mermaid-block-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      <CopyButton text={code} className="code-block-copy" label="Copy source" />
    </div>
  );
}
