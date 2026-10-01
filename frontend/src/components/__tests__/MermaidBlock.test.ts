// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, StrictMode } from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import { MermaidBlock } from '../MermaidBlock';

const { initialize, renderDiagram } = vi.hoisted(() => ({
  initialize: vi.fn(),
  renderDiagram: vi.fn(),
}));
vi.mock('mermaid', () => ({ default: { initialize, render: renderDiagram } }));
beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.setAttribute('data-theme', 'dark');
  renderDiagram.mockResolvedValue({ svg: '<svg><text>diagram</text></svg>' });
});
afterEach(cleanup);
const code = 'graph TD; A-->B;';

function pendingRender() {
  let resolve!: (value: { svg: string }) => void;
  const promise = new Promise<{ svg: string }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MermaidBlock', () => {
  it('keeps the source and copy control available while rendering', () => {
    renderDiagram.mockReturnValue(new Promise(() => {}));
    const view = render(createElement(MermaidBlock, { code }));
    expect(view.container.textContent).toContain(code);
    expect(view.getByRole('button', { name: 'Copy code' })).toBeDefined();
    view.unmount();
  });

  it('renders strict SVG and sanitizes the result before insertion', async () => {
    renderDiagram.mockResolvedValue({
      svg: '<svg onload="alert(1)"><script>alert(1)</script><text>diagram</text><a href="javascript:alert(1)">unsafe</a></svg>',
    });
    const view = render(createElement(MermaidBlock, { code }));
    await waitFor(() => expect(view.container.querySelector('.mermaid-block-svg')).not.toBeNull());
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', theme: 'dark', startOnLoad: false }),
    );
    expect(view.container.innerHTML).toContain('diagram');
    expect(view.container.innerHTML).not.toMatch(/onload|<script|javascript:/);
  });

  it('preserves sanitized HTML diagram labels inside foreignObject', async () => {
    renderDiagram.mockResolvedValue({
      svg: '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span>Label</span><img src="x" onerror="alert(1)"></div></foreignObject></svg>',
    });
    const view = render(createElement(MermaidBlock, { code }));
    await waitFor(() => expect(view.container.querySelector('.mermaid-block-svg')).not.toBeNull());
    expect(view.container.querySelector('foreignObject')).not.toBeNull();
    expect(view.container.textContent).toContain('Label');
    expect(view.container.innerHTML).not.toContain('onerror');
  });

  it('keeps invalid source readable and removes the owned render container', async () => {
    renderDiagram.mockRejectedValue(new Error('parse error'));
    const view = render(createElement(MermaidBlock, { code: 'invalid{{{' }));
    await waitFor(() => expect(renderDiagram).toHaveBeenCalled());
    await act(async () => {});
    expect(view.container.textContent).toContain('invalid{{{');
    expect(view.getByRole('button', { name: 'Copy code' })).toBeDefined();
    expect(renderDiagram.mock.calls[0][2].isConnected).toBe(false);
  });

  it('does not start rendering after unmount during the lazy import', async () => {
    const view = render(createElement(MermaidBlock, { code }));
    view.unmount();
    await act(async () => {});
    expect(renderDiagram).not.toHaveBeenCalled();
  });

  it('removes its container on unmount while rendering is in flight', async () => {
    const pending = pendingRender();
    renderDiagram.mockReturnValue(pending.promise);
    const view = render(createElement(MermaidBlock, { code }));
    await waitFor(() => expect(renderDiagram).toHaveBeenCalled());
    const container = renderDiagram.mock.calls[0][2] as HTMLElement;
    expect(container.isConnected).toBe(true);
    view.unmount();
    expect(container.isConnected).toBe(false);
    await act(async () => pending.resolve({ svg: '<svg><text>late</text></svg>' }));
    expect(document.querySelector('.mermaid-block-svg')).toBeNull();
  });

  it('rejects stale results and gives each changed source a unique render ID', async () => {
    const pending = pendingRender();
    renderDiagram
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ svg: '<svg><text>new</text></svg>' });
    const view = render(createElement(MermaidBlock, { code }));
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledTimes(1));
    view.rerender(createElement(MermaidBlock, { code: 'graph LR; X-->Y;' }));
    expect(view.container.textContent).toContain('graph LR; X-->Y;');
    await act(async () => pending.resolve({ svg: '<svg><text>old</text></svg>' }));
    await waitFor(() => expect(view.container.textContent).toContain('new'));
    expect(view.container.textContent).not.toContain('old');
    expect(renderDiagram.mock.calls[0][0]).not.toBe(renderDiagram.mock.calls[1][0]);
  });

  it('renders multiple instances in StrictMode without sharing IDs or containers', async () => {
    const view = render(
      createElement(
        StrictMode,
        null,
        createElement(MermaidBlock, { code }),
        createElement(MermaidBlock, { code }),
      ),
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll('.mermaid-block-svg')).toHaveLength(2),
    );
    const ids = renderDiagram.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const call of renderDiagram.mock.calls) expect(call[2].isConnected).toBe(false);
  });

  it('rerenders when the app switches to light theme', async () => {
    const view = render(createElement(MermaidBlock, { code }));
    await waitFor(() => expect(view.container.querySelector('.mermaid-block-svg')).not.toBeNull());
    await act(async () => document.documentElement.setAttribute('data-theme', 'light'));
    await waitFor(() =>
      expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' })),
    );
    expect(renderDiagram).toHaveBeenCalledTimes(2);
  });
});
