// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ThinkingBlock } from '../ThinkingBlock';
import type { StreamingBlock, FinishedBlock } from '../../types/chat';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ThinkingBlock', () => {
  it('shows "Thinking..." when streaming and not done', () => {
    const block: StreamingBlock = {
      blockId: 'b1',
      blockType: 'thinking',
      content: 'considering...',
      done: false,
    };
    render(<ThinkingBlock block={block} streaming={true} />);
    expect(screen.getByText('Thinking...')).toBeTruthy();
  });

  it('shows "Thought" when done', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'thinking',
      content: 'I thought about it.',
    };
    render(<ThinkingBlock block={block} />);
    expect(screen.getByText('Thought')).toBeTruthy();
  });

  it('shows "Reasoning redacted" for redacted_thinking', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'redacted_thinking',
      content: '',
    };
    render(<ThinkingBlock block={block} />);
    expect(screen.getByText('Reasoning redacted')).toBeTruthy();
  });

  it('returns null when content is empty and not streaming', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'thinking',
      content: '',
    };
    const { container } = render(<ThinkingBlock block={block} />);
    expect(container.innerHTML).toBe('');
  });
});

it('keeps completed thinking readable for 30 seconds then allows reopening', () => {
  vi.useFakeTimers();
  render(
    <ThinkingBlock block={{ blockId: 'b1', blockType: 'thinking', content: 'Readable summary' }} />,
  );
  expect(screen.getByText('Readable summary')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(29_999);
  });
  expect(screen.getByText('Readable summary')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText('Readable summary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Thought/ }));
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText('Readable summary')).toBeTruthy();
});
it('starts the reading window after streaming finishes', () => {
  vi.useFakeTimers();
  const block: StreamingBlock = {
    blockId: 'b1',
    blockType: 'thinking',
    content: 'Streaming summary',
    done: false,
  };
  const { rerender } = render(<ThinkingBlock block={block} streaming />);
  act(() => {
    vi.advanceTimersByTime(120_000);
  });
  expect(screen.getByText('Streaming summary')).toBeTruthy();
  rerender(<ThinkingBlock block={{ ...block, done: true }} streaming />);
  act(() => {
    vi.advanceTimersByTime(29_999);
  });
  expect(screen.getByText('Streaming summary')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByText('Streaming summary')).toBeNull();
});
it('gives longer summaries enough reading time and respects manual expansion', () => {
  vi.useFakeTimers();
  const content = Array(200).fill('word').join(' ');
  render(<ThinkingBlock block={{ blockId: 'b1', blockType: 'thinking', content }} />);
  act(() => {
    vi.advanceTimersByTime(30_000);
  });
  expect(screen.getByText(content)).toBeTruthy();
  const button = screen.getByRole('button', { name: /Thought/ });
  fireEvent.click(button);
  fireEvent.click(button);
  act(() => {
    vi.advanceTimersByTime(120_000);
  });
  expect(screen.getByText(content)).toBeTruthy();
});
