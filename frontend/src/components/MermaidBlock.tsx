import { useEffect, useId, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';

// Mermaid configuration is global: keep each initialization paired with its render.
let renderQueue: Promise<unknown> = Promise.resolve();
type Theme = 'dark' | 'light';
const currentTheme = (): Theme =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

function renderDiagram(id: string, code: string, theme: Theme, signal: AbortSignal) {
  const job = renderQueue.then(async () => {
    if (signal.aborted) return null;
    const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([
      import('mermaid'),
      import('dompurify'),
    ]);
    if (signal.aborted) return null;
    const container = document.createElement('div');
    container.style.cssText =
      'position:absolute;left:-100000px;visibility:hidden;pointer-events:none';
    container.setAttribute('aria-hidden', 'true');
    document.body.appendChild(container);
    const remove = () => container.remove();
    signal.addEventListener('abort', remove, { once: true });
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: theme === 'dark' ? 'dark' : 'default',
      });
      const { svg } = await mermaid.render(id, code, container);
      // Also sanitize at the DOM boundary, independently of Mermaid's strict mode.
      return signal.aborted ? null : DOMPurify.sanitize(svg);
    } finally {
      signal.removeEventListener('abort', remove);
      remove();
    }
  });
  renderQueue = job.catch(() => {});
  return job;
}

export function MermaidBlock({ code }: { code: string }) {
  const instanceId = useId();
  const generation = useRef(0);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [result, setResult] = useState<{ code: string; theme: Theme; svg: string } | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const id = `mermaid-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '')}-${++generation.current}`;
    renderDiagram(id, code, theme, controller.signal).then(
      (svg) => {
        if (svg && !controller.signal.aborted) setResult({ code, theme, svg });
      },
      () => {}, // Invalid or incomplete streamed diagrams retain their source fallback.
    );
    return () => controller.abort();
  }, [code, theme, instanceId]);

  if (!result || result.code !== code || result.theme !== theme) {
    return (
      <div className="code-block-wrapper">
        <pre>
          <code>{code}</code>
        </pre>
        <CopyButton text={code} className="code-block-copy" label="Copy code" />
      </div>
    );
  }

  return (
    <div className="mermaid-block">
      <div className="mermaid-block-svg" dangerouslySetInnerHTML={{ __html: result.svg }} />
      <CopyButton text={code} className="code-block-copy" label="Copy source" />
    </div>
  );
}
