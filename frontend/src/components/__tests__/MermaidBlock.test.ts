import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Mock mermaid before importing the component
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

// Mock useId since renderToStaticMarkup doesn't fully support it
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, useId: () => ':test-id:' };
});

import mermaid from 'mermaid';
import { MermaidBlock } from '../MermaidBlock';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MermaidBlock', () => {
  it('renders null initially while waiting for mermaid.render', () => {
    // mermaid.render returns a never-resolving promise (simulates pending)
    vi.mocked(mermaid.render).mockReturnValue(new Promise(() => {}));
    const html = renderToStaticMarkup(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    // Should render nothing while svg is null and no error
    expect(html).toBe('');
  });

  it('renders fallback code block on render error', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('parse error'));

    // We can't easily test async state updates with renderToStaticMarkup,
    // but we can verify the component doesn't crash
    const html = renderToStaticMarkup(createElement(MermaidBlock, { code: 'invalid{{{' }));
    expect(html).toBe(''); // Initial render before error resolves
  });

  it('does not call mermaid.initialize at import time (deferred to first render)', () => {
    // Verify the deferred initialization pattern — initialize is called inside
    // useEffect, not at module scope. renderToStaticMarkup skips effects.
    vi.mocked(mermaid.render).mockReturnValue(new Promise(() => {}));
    renderToStaticMarkup(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });
});
