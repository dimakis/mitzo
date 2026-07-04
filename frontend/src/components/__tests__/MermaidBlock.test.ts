// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, act, cleanup } from '@testing-library/react';

// Mock mermaid before importing the component
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

import mermaid from 'mermaid';
import { MermaidBlock } from '../MermaidBlock';

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('MermaidBlock', () => {
  it('renders null initially while waiting for mermaid.render', () => {
    vi.mocked(mermaid.render).mockReturnValue(new Promise(() => {}));
    const html = renderToStaticMarkup(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    expect(html).toBe('');
  });

  it('does not call mermaid.initialize at import time (deferred to useEffect)', () => {
    vi.mocked(mermaid.render).mockReturnValue(new Promise(() => {}));
    renderToStaticMarkup(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('renders SVG and initializes with securityLevel strict', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg>diagram</svg>',
    });
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    });
    // Verify rendered output
    const block = document.querySelector('.mermaid-block-svg');
    expect(block).not.toBeNull();
    expect(block!.innerHTML).toContain('diagram');
    // Verify security config on first initialization
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' }),
    );
  });

  it('renders fallback code block on render error', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('parse error'));
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'invalid{{{' }));
    });
    const wrapper = document.querySelector('.code-block-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.textContent).toContain('invalid{{{');
  });
});
