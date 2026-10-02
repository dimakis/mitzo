// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SubagentCard } from '../SubagentCard';
import type { FinishedBlock } from '../../types/chat';

afterEach(() => cleanup());

function wrap(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

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

    render(wrap(<SubagentCard subagent={subagent} />));

    expect(screen.getByText('Search complete')).toBeTruthy();
    // Token display now uses k-formatting for >=1000, raw for <1000
    expect(screen.getByText(/100.*50/)).toBeTruthy();
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

    render(wrap(<SubagentCard subagent={subagent} />));

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

    const { container } = render(wrap(<SubagentCard subagent={subagent} />));

    // Initially collapsed - detail not visible
    expect(container.querySelector('.tool-pill-detail')).not.toBeTruthy();

    // Click to expand — now uses tool-pill-header
    const header = container.querySelector('.tool-pill-header');
    if (header) {
      fireEvent.click(header);
    }

    // Now detail section is visible
    expect(container.querySelector('.tool-pill-detail')).toBeTruthy();
    expect(screen.getByText('Search results here')).toBeTruthy();
  });

  it('passes the session to nested artifact links', () => {
    const subagent = {
      messageId: 'nested',
      blocks: [
        { blockId: 'text', blockType: 'text' as const, content: '[report](outputs/report.html)' },
      ],
      summary: 'Done',
    };
    function Location() {
      const location = useLocation();
      return <output data-testid="location">{location.pathname + location.search}</output>;
    }
    render(
      <MemoryRouter initialEntries={['/chat/origin']}>
        <SubagentCard subagent={subagent} sessionId="origin" />
        <Location />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Agent/ }));
    fireEvent.click(screen.getByRole('link', { name: 'report' }));
    const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
    expect(url.searchParams.get('path')).toBe('outputs/report.html');
    expect(url.searchParams.get('sessionId')).toBe('origin');
  });

  it('shows pulsing indicator when running', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: new Map(),
      blockOrder: [],
      running: true as const,
    };

    const { container } = render(wrap(<SubagentCard subagent={subagent} />));

    // Now uses tool-pill-dot--pending (pulsing)
    const dot = container.querySelector('.tool-pill-dot--pending');
    expect(dot).toBeTruthy();
  });

  it('shows done indicator when complete', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: [],
      summary: 'Complete',
    };

    const { container } = render(wrap(<SubagentCard subagent={subagent} />));

    const dot = container.querySelector('.tool-pill-dot--done');
    expect(dot).toBeTruthy();
  });

  it('shows tool count badge when agent has nested tool calls', () => {
    const blocks: FinishedBlock[] = [
      {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: 'foo.ts',
        toolResult: '...',
      },
      {
        blockId: 'b2',
        blockType: 'tool_use',
        content: '',
        toolName: 'Grep',
        toolInput: 'bar',
        toolResult: '...',
      },
      { blockId: 'b3', blockType: 'text', content: 'Done' },
    ];

    const subagent = {
      messageId: 'msg-sub-1',
      blocks,
      summary: 'Searched 2 files',
    };

    const { container } = render(wrap(<SubagentCard subagent={subagent} />));

    const badge = container.querySelector('.tool-pill-badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('2');
  });

  it('renders with agent modifier class', () => {
    const subagent = {
      messageId: 'msg-sub-1',
      blocks: [],
      summary: 'Done',
    };

    const { container } = render(wrap(<SubagentCard subagent={subagent} />));

    expect(container.querySelector('.tool-pill--agent')).toBeTruthy();
  });
});
