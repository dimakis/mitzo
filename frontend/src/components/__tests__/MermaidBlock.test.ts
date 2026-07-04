// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, act, cleanup } from '@testing-library/react';

const mockInitialize = vi.fn();
const mockRender = vi.fn();

// Mock the dynamic import('mermaid') that MermaidBlock uses
vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

// Each test that needs a fresh module-level `mermaidInitialized` flag uses
// vi.resetModules() + dynamic import, avoiding a test-only export.
async function freshMermaidBlock() {
  vi.resetModules();
  const mod = await import('../MermaidBlock');
  return mod.MermaidBlock;
}

describe('MermaidBlock', () => {
  it('renders SVG and initializes with securityLevel strict', async () => {
    mockRender.mockResolvedValue({
      svg: '<svg>diagram</svg>',
      diagramType: 'flowchart',
      bindFunctions: undefined,
    });
    const MermaidBlock = await freshMermaidBlock();
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    });
    const block = document.querySelector('.mermaid-block-svg');
    expect(block).not.toBeNull();
    expect(block!.innerHTML).toContain('diagram');
    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict' }),
    );
  });

  it('renders fallback code block on render error', async () => {
    mockRender.mockRejectedValue(new Error('parse error'));
    const MermaidBlock = await freshMermaidBlock();
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'invalid{{{' }));
    });
    const wrapper = document.querySelector('.code-block-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.textContent).toContain('invalid{{{');
  });

  it('only initializes mermaid once across multiple renders', async () => {
    mockRender.mockResolvedValue({
      svg: '<svg>a</svg>',
      diagramType: 'flowchart',
      bindFunctions: undefined,
    });
    // Use the same module instance for both renders (no resetModules)
    const { MermaidBlock } = await import('../MermaidBlock');
    // Reset init state via fresh module for this test
    const Fresh = await freshMermaidBlock();
    await act(async () => {
      render(createElement(Fresh, { code: 'graph TD; A-->B;' }));
    });
    cleanup();
    // Re-import from cache (same module instance, flag already set)
    const { MermaidBlock: Same } = await import('../MermaidBlock');
    await act(async () => {
      render(createElement(Same, { code: 'graph LR; X-->Y;' }));
    });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  it('does not update state after unmount (cancellation)', async () => {
    // Simulate a slow render that resolves after the component unmounts
    let resolveRender: (v: unknown) => void;
    const renderPromise = new Promise((resolve) => {
      resolveRender = resolve;
    });
    mockRender.mockReturnValue(renderPromise);

    const MermaidBlock = await freshMermaidBlock();
    const { unmount } = render(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));

    // Unmount before render resolves — sets cancelled = true
    unmount();

    // Now resolve the render — the cancelled flag should prevent setSvg
    await act(async () => {
      resolveRender!({
        svg: '<svg>late</svg>',
        diagramType: 'flowchart',
        bindFunctions: undefined,
      });
    });

    // No SVG should appear in the document (component is unmounted and
    // the state update was skipped)
    expect(document.querySelector('.mermaid-block-svg')).toBeNull();
  });
});
