import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { extractText } from '../extractText';

describe('extractText', () => {
  it('returns empty string for null/undefined/boolean', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
    expect(extractText(true)).toBe('');
    expect(extractText(false)).toBe('');
  });

  it('returns string as-is', () => {
    expect(extractText('hello world')).toBe('hello world');
  });

  it('converts numbers to strings', () => {
    expect(extractText(42)).toBe('42');
  });

  it('extracts text from a React element', () => {
    const el = createElement('span', null, 'inner text');
    expect(extractText(el)).toBe('inner text');
  });

  it('extracts text from nested elements', () => {
    const el = createElement('pre', null, createElement('code', null, 'const x = 1;'));
    expect(extractText(el)).toBe('const x = 1;');
  });

  it('concatenates text from arrays', () => {
    const el = createElement('pre', null, 'line 1\n', createElement('code', null, 'line 2'));
    expect(extractText(el)).toBe('line 1\nline 2');
  });
});
