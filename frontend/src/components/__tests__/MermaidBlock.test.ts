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

import { MermaidBlock, _resetMermaidInit } from '../MermaidBlock';

beforeEach(() => {
  vi.clearAllMocks();
  _resetMermaidInit();
  cleanup();
});

describe('MermaidBlock', () => {
  it('renders SVG and initializes with securityLevel strict', async () => {
    mockRender.mockResolvedValue({
      svg: '<svg>diagram</svg>',
      diagramType: 'flowchart',
      bindFunctions: undefined,
    });
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
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'graph TD; A-->B;' }));
    });
    cleanup();
    await act(async () => {
      render(createElement(MermaidBlock, { code: 'graph LR; X-->Y;' }));
    });
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });
});
