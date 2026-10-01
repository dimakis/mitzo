import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { getMermaidCode } from '../mermaid-detect';

describe('getMermaidCode', () => {
  it('returns code for language-mermaid class', () => {
    const code = createElement('code', { className: 'language-mermaid' }, 'graph TD; A-->B;');
    expect(getMermaidCode(code)).toBe('graph TD; A-->B;');
  });

  it('returns code when language-mermaid is among multiple classes', () => {
    const code = createElement('code', { className: 'hljs language-mermaid' }, 'graph LR;');
    expect(getMermaidCode(code)).toBe('graph LR;');
  });

  it('returns null for non-mermaid language', () => {
    const code = createElement('code', { className: 'language-python' }, 'print("hi")');
    expect(getMermaidCode(code)).toBeNull();
  });

  it('returns null when className is missing', () => {
    const code = createElement('code', null, 'plain text');
    expect(getMermaidCode(code)).toBeNull();
  });

  it('returns null for null/undefined children', () => {
    expect(getMermaidCode(null)).toBeNull();
    expect(getMermaidCode(undefined)).toBeNull();
  });

  it('returns null for non-element children', () => {
    expect(getMermaidCode('just a string')).toBeNull();
  });

  it('does not match language-mermaid-extended (word boundary)', () => {
    const code = createElement('code', { className: 'language-mermaid-extended' }, 'test');
    expect(getMermaidCode(code)).toBeNull();
  });
});
