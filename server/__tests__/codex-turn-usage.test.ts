import { describe, expect, it } from 'vitest';
import { CodexTurnUsage } from '../codex-turn-usage.js';

const totals = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: inputTokens + outputTokens,
});
const update = (capture: CodexTurnUsage, turnId: string, total: ReturnType<typeof totals>) =>
  capture.update({ turnId, tokenUsage: { total, last: totals(1, 1) } });

describe('native cumulative usage attribution', () => {
  it('uses cumulative deltas across requests and turns, not tokenUsage.last, and deduplicates replay', () => {
    const capture = new CodexTurnUsage(true);
    capture.start('one');
    update(capture, 'one', totals(100, 20, 70));
    update(capture, 'one', totals(160, 40, 90));
    update(capture, 'one', totals(160, 40, 90));
    expect(capture.finish('one')).toEqual({
      input_tokens: 70,
      output_tokens: 40,
      cache_read_input_tokens: 90,
    });
    expect(capture.finish('one')).toBeUndefined();
    capture.start('two');
    update(capture, 'two', totals(210, 50, 100));
    expect(capture.finish('two')).toEqual({
      input_tokens: 40,
      output_tokens: 10,
      cache_read_input_tokens: 10,
    });
  });
  it('does not treat resumed history as newly billed work; a terminal snapshot can baseline the following turn', () => {
    const capture = new CodexTurnUsage();
    capture.start('resume');
    update(capture, 'resume', totals(1000, 100));
    expect(capture.finish('resume')).toBeUndefined();
    capture.start('next');
    update(capture, 'next', totals(1030, 110));
    expect(capture.finish('next')).toMatchObject({ input_tokens: 30, output_tokens: 10 });
  });
  it.each(['missing', 'reset', 'wrong-turn', 'invalid'])('leaves %s usage unknown', (kind) => {
    const capture = new CodexTurnUsage(true);
    capture.start('one');
    if (kind !== 'missing') update(capture, 'one', totals(100, 20));
    if (kind === 'reset') update(capture, 'one', totals(10, 2));
    if (kind === 'wrong-turn') update(capture, 'other', totals(120, 25));
    if (kind === 'invalid') update(capture, 'one', totals(110, 25, 999));
    expect(capture.finish('one')).toBeUndefined();
  });
  it('does not let a late usage event repair a sealed result or contaminate the following turn', () => {
    const capture = new CodexTurnUsage(true);
    capture.start('one');
    expect(capture.finish('one')).toBeUndefined();
    update(capture, 'one', totals(100, 20));
    capture.start('two');
    update(capture, 'two', totals(150, 30));
    expect(capture.finish('two')).toBeUndefined();
  });
  it('does not seal on a mismatched terminal and invalidates uncertain reconnect intervals', () => {
    const capture = new CodexTurnUsage(true);
    capture.start('one');
    update(capture, 'one', totals(100, 20));
    expect(capture.finish('wrong')).toBeUndefined();
    capture.invalidate();
    update(capture, 'one', totals(130, 30));
    expect(capture.finish('one')).toBeUndefined();
  });
});
