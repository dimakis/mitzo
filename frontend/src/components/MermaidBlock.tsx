import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { CopyButton } from './CopyButton';

mermaid.initialize({
  startOnLoad: false,
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

let renderCounter = 0;

interface MermaidBlockProps {
  code: string;
}

export function MermaidBlock({ code }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++renderCounter}`;

    async function render() {
      try {
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('Invalid diagram');
          setSvg(null);
        }
        // Clean up any leftover element mermaid may have created
        document.getElementById(`d${id}`)?.remove();
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    // Fall back to plain code block
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
      <div
        className="mermaid-block-svg"
        ref={containerRef}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <CopyButton text={code} className="code-block-copy" label="Copy source" />
    </div>
  );
}
