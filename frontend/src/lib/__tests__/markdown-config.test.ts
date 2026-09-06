import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { markdownComponents } from '../markdown-config';

describe('markdownComponents.pre', () => {
  const pre = markdownComponents.pre!;

  it('renders MermaidBlock for language-mermaid code blocks', () => {
    const codeEl = createElement('code', { className: 'language-mermaid' }, 'graph TD; A-->B;');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (pre as any)({ children: codeEl });
    expect(result.type).not.toBe('pre');
    expect(result.props.code).toBe('graph TD; A-->B;');
  });

  it('renders normal pre for non-mermaid code blocks', () => {
    const codeEl = createElement('code', { className: 'language-python' }, 'print("hi")');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (pre as any)({ children: codeEl });
    expect(result.type).toBe('pre');
  });

  it('renders normal pre when code has no className', () => {
    const codeEl = createElement('code', null, 'plain text');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (pre as any)({ children: codeEl });
    expect(result.type).toBe('pre');
  });
});
