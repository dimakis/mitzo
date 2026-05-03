// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SubagentCard } from '../SubagentCard';
import type { FinishedBlock } from '../../types/chat';

afterEach(() => cleanup());

describe('SubagentCard', () => {
  it('renders collapsed by default with summary', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: [
        {
          blockId: 'b1',
          blockType: 'text' as const,
          content: 'Subagent output',
        },
      ],
      summary: 'Search complete',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };

    render(<SubagentCard subagent={subagent} />);

    expect(screen.getByText('Search complete')).toBeTruthy();
    expect(screen.getByText(/100.*50/)).toBeTruthy(); // Token display
  });

  it('renders "Working..." when subagent is still running', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: new Map([
        [
          'b1',
          {
            blockId: 'b1',
            blockType: 'thinking' as const,
            content: 'Analyzing...',
            done: false,
          },
        ],
      ]),
      blockOrder: ['b1'],
      running: true as const,
    };

    render(<SubagentCard subagent={subagent} />);

    expect(screen.getByText('Working...')).toBeTruthy();
  });

  it('expands to show nested blocks when clicked', () => {
    const blocks: FinishedBlock[] = [
      {
        blockId: 'b1',
        blockType: 'thinking',
        content: 'Let me search for that',
      },
      {
        blockId: 'b2',
        blockType: 'text',
        content: 'Search results here',
      },
    ];

    const subagent = {
      messageId: 'msg-sub-1',
      blocks,
      summary: 'Done',
    };

    const { container } = render(<SubagentCard subagent={subagent} />);

    // Initially collapsed - detail not visible
    expect(container.querySelector('.subagent-detail')).not.toBeTruthy();

    // Click to expand
    const header = container.querySelector('.subagent-header');
    if (header) {
      fireEvent.click(header);
    }

    // Now detail section is visible
    expect(container.querySelector('.subagent-detail')).toBeTruthy();
    expect(screen.getByText('Search results here')).toBeTruthy();
  });

  it('shows pulsing indicator when running', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: new Map(),
      blockOrder: [],
      running: true as const,
    };

    const { container } = render(<SubagentCard subagent={subagent} />);

    const dot = container.querySelector('.subagent-dot--running');
    expect(dot).toBeTruthy();
  });

  it('shows checkmark when complete', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: [],
      summary: 'Complete',
    };

    const { container } = render(<SubagentCard subagent={subagent} />);

    const dot = container.querySelector('.subagent-dot--done');
    expect(dot).toBeTruthy();
  });
});
