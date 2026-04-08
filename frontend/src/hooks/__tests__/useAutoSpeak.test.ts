// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoSpeak } from '../useAutoSpeak';
import type { FinishedMessage } from '../../types/chat';

// Mock tts module so we can verify stripCodeForTts / truncateForTts are called
vi.mock('../../lib/tts', () => ({
  stripCodeForTts: vi.fn((t: string) => t),
  truncateForTts: vi.fn((t: string) => t),
}));

function makeMsg(
  role: 'user' | 'assistant',
  text: string,
  id = `msg-${Math.random()}`,
): FinishedMessage {
  return {
    messageId: id,
    role,
    blocks: [{ blockId: 'b1', blockType: 'text', content: text }],
  };
}

function baseOpts(overrides: Partial<Parameters<typeof useAutoSpeak>[0]> = {}) {
  return {
    messages: [] as FinishedMessage[],
    running: false,
    ttsEnabled: true,
    ttsAvailable: true,
    speak: vi.fn(),
    ...overrides,
  };
}

describe('useAutoSpeak', () => {
  it('speaks the last assistant message when streaming completes', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Hello there.');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(speak).toHaveBeenCalledWith('Hello there.');
  });

  it('speaks assistant messages immediately even while running', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Let me check that.', 'msg-1');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], running: true, speak })));

    expect(speak).toHaveBeenCalledWith('Let me check that.');
  });

  it('speaks each new assistant message during a multi-turn tool-use session', () => {
    const speak = vi.fn();
    const msg1 = makeMsg('assistant', 'Checking the file.', 'msg-1');

    const { rerender } = renderHook((props) => useAutoSpeak(props), {
      initialProps: baseOpts({ messages: [msg1], running: true, speak }),
    });

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('Checking the file.');

    // Second assistant message arrives (after tool result)
    const msg2 = makeMsg('assistant', 'Here is what I found.', 'msg-2');
    rerender(baseOpts({ messages: [msg1, msg2], running: true, speak }));

    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenCalledWith('Here is what I found.');
  });

  it('does not speak the same message twice', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Hello.', 'msg-1');
    const opts = baseOpts({ messages: [msg], speak });
    const { rerender } = renderHook((props) => useAutoSpeak(props), { initialProps: opts });

    expect(speak).toHaveBeenCalledTimes(1);

    // Re-render with same messages
    rerender(opts);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('does not re-speak earlier messages when running transitions to false', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Already spoken.', 'msg-1');

    const { rerender } = renderHook((props) => useAutoSpeak(props), {
      initialProps: baseOpts({ messages: [msg], running: true, speak }),
    });

    expect(speak).toHaveBeenCalledTimes(1);

    // running → false, same messages — should not re-speak
    rerender(baseOpts({ messages: [msg], running: false, speak }));
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('does not speak when ttsEnabled is false', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Hello.');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], ttsEnabled: false, speak })));

    expect(speak).not.toHaveBeenCalled();
  });

  it('does not speak when ttsAvailable is false', () => {
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Hello.');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], ttsAvailable: false, speak })));

    expect(speak).not.toHaveBeenCalled();
  });

  it('does not speak when last message is from user', () => {
    const speak = vi.fn();
    const msg = makeMsg('user', 'Hello.');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(speak).not.toHaveBeenCalled();
  });

  it('does not speak empty text blocks', () => {
    const speak = vi.fn();
    const msg: FinishedMessage = {
      messageId: 'msg-empty',
      role: 'assistant',
      blocks: [{ blockId: 'b1', blockType: 'text', content: '   ' }],
    };
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(speak).not.toHaveBeenCalled();
  });

  it('joins multiple text blocks', () => {
    const speak = vi.fn();
    const msg: FinishedMessage = {
      messageId: 'msg-multi',
      role: 'assistant',
      blocks: [
        { blockId: 'b1', blockType: 'text', content: 'First.' },
        { blockId: 'b2', blockType: 'tool_use', content: 'tool stuff', toolName: 'read' },
        { blockId: 'b3', blockType: 'text', content: 'Second.' },
      ],
    };
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(speak).toHaveBeenCalledWith('First.\nSecond.');
  });

  it('calls stripCodeForTts and truncateForTts', async () => {
    const { stripCodeForTts, truncateForTts } = await import('../../lib/tts');
    const speak = vi.fn();
    const msg = makeMsg('assistant', 'Some text.');
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(stripCodeForTts).toHaveBeenCalledWith('Some text.');
    expect(truncateForTts).toHaveBeenCalled();
  });

  it('skips assistant messages with only non-text blocks', () => {
    const speak = vi.fn();
    const msg: FinishedMessage = {
      messageId: 'msg-tools-only',
      role: 'assistant',
      blocks: [{ blockId: 'b1', blockType: 'tool_use', content: '{}', toolName: 'read' }],
    };
    renderHook(() => useAutoSpeak(baseOpts({ messages: [msg], speak })));

    expect(speak).not.toHaveBeenCalled();
  });
});
