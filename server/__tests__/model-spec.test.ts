import { describe, it, expect } from 'vitest';
import { parseModelSpec, resolveThinking } from '../chat.js';

describe('parseModelSpec', () => {
  it('returns empty model and no effort for undefined', () => {
    expect(parseModelSpec(undefined)).toEqual({ model: '', effort: undefined });
  });

  it('parses a plain model ID', () => {
    expect(parseModelSpec('claude-opus-4-7')).toEqual({
      model: 'claude-opus-4-7',
      effort: undefined,
    });
  });

  it('splits model and effort on colon', () => {
    expect(parseModelSpec('claude-opus-4-7:max')).toEqual({
      model: 'claude-opus-4-7',
      effort: 'max',
    });
  });

  it('handles trailing colon as empty effort', () => {
    expect(parseModelSpec('claude-opus-4-7:')).toEqual({ model: 'claude-opus-4-7', effort: '' });
  });

  it('handles multiple colons — only splits on first', () => {
    expect(parseModelSpec('claude-opus-4-7:max:extra')).toEqual({
      model: 'claude-opus-4-7',
      effort: 'max:extra',
    });
  });
});

describe('resolveThinking', () => {
  it('returns adaptive for undefined (default)', () => {
    expect(resolveThinking(undefined)).toEqual({ type: 'adaptive' });
  });

  it('returns adaptive for plain opus model', () => {
    expect(resolveThinking('claude-opus-4-7')).toEqual({ type: 'adaptive' });
  });

  it('returns adaptive for opus 4-6', () => {
    expect(resolveThinking('claude-opus-4-6')).toEqual({ type: 'adaptive' });
  });

  it('returns 128k budget for opus :max', () => {
    expect(resolveThinking('claude-opus-4-7:max')).toEqual({
      type: 'enabled',
      budgetTokens: 128_000,
    });
  });

  it('returns 10k budget for sonnet', () => {
    expect(resolveThinking('claude-sonnet-4-6')).toEqual({
      type: 'enabled',
      budgetTokens: 10_000,
    });
  });

  it('returns undefined for haiku', () => {
    expect(resolveThinking('claude-haiku-4-5')).toBeUndefined();
  });
});
