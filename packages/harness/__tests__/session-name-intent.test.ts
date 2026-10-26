import { describe, expect, it } from 'vitest';
import { extractRecentPrompts, generateSessionNameFallback } from '../src/auto-rename.js';
import type { StoredEvent } from '@mitzo/protocol';

describe('readable local session titles', () => {
  it('retains word order and connecting words instead of ranking keywords', () => {
    expect(generateSessionNameFallback(['Could you please fix the login bug?'])).toBe(
      'Fix the login bug',
    );
    expect(
      generateSessionNameFallback(['Compare caching and retries', 'retries retries retries']),
    ).toBe('Compare caching and retries');
  });
  it('keeps the original task when later messages are acknowledgements', () => {
    expect(
      generateSessionNameFallback([
        'Fix session title generation',
        'Yep',
        'Fixed now',
        'Looks good',
      ]),
    ).toBe('Fix session title generation');
  });
  it('skips greetings, command noise and installation hashes', () => {
    expect(
      generateSessionNameFallback([
        'Yep',
        '--install 5ecfa3e13b2e67ec5f91b4aa86b186fee1e192d278576627',
        'Please repair the plugin installation',
      ]),
    ).toBe('Repair the plugin installation');
    expect(generateSessionNameFallback(['The and and the', 'Thanks', 'Go ahead'])).toBe('');
  });
  it('does not let a pasted code block displace the request', () => {
    expect(
      generateSessionNameFallback([
        '```sh\nnpm install --force\n```\nCan you fix plugin installation?',
      ]),
    ).toBe('Fix plugin installation');
  });
  it('keeps technical names intact and truncates at word boundaries', () => {
    expect(
      generateSessionNameFallback(['Fix SessionList.tsx search scrolling. Then add tests.']),
    ).toBe('Fix SessionList.tsx search scrolling');
    const title = generateSessionNameFallback([
      'Implement comprehensive authentication and authorization with multifactor verification',
    ]);
    expect(title).toBe('Implement comprehensive authentication and authorization');
    expect(title.length).toBeLessThanOrEqual(60);
  });
  it('retains the first meaningful request after more than eight prompts', () => {
    const texts = [
      'Hello',
      'Fix session title generation',
      ...Array.from({ length: 10 }, () => 'Yep'),
    ];
    const events: StoredEvent[] = texts.map((text, seq) => ({
      seq,
      sessionId: 's',
      type: 'user_message',
      payload: { text },
      createdAt: seq,
    }));
    const prompts = extractRecentPrompts(events);
    expect(prompts).toHaveLength(8);
    expect(prompts[0]).toBe('Fix session title generation');
    expect(generateSessionNameFallback(prompts)).toBe('Fix session title generation');
  });
});
