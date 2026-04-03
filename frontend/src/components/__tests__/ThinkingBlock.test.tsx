// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingBlock } from '../ThinkingBlock';
import type { StreamingBlock, FinishedBlock } from '../../types/chat';

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
