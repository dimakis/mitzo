// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToolGroup } from '../ToolGroup';
import type { FinishedBlock } from '../../types/chat';

function wrap(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

function makeTool(id: string, done: boolean): FinishedBlock {
  return {
    blockId: id,
    blockType: 'tool_use',
    content: '',
    toolName: 'Read',
    toolInput: 'file.txt',
    ...(done ? { toolResult: 'ok' } : {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('ToolGroup', () => {
  it('shows tool count label when all done', () => {
    const tools = [makeTool('t1', true), makeTool('t2', true), makeTool('t3', true)];
    render(wrap(<ToolGroup tools={tools} />));
    expect(screen.getByText('3 tool calls')).toBeTruthy();
  });

  it('starts collapsed, reveals independent tool rows when expanded, and exposes disclosure ARIA', () => {
    const tools = [makeTool('t1', true)];
    render(wrap(<ToolGroup tools={tools} />));

    const toggle = screen.getByRole('button', { name: /1 tool call/i });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const contentId = toggle.getAttribute('aria-controls');
    expect(contentId).toBeTruthy();
    expect(document.getElementById(contentId!)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(contentId!)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Read/ })).toBeTruthy();
  });

  it('keeps user expansion as tools complete and reports running work live', () => {
    const running = [makeTool('t1', false), makeTool('t2', false)];
    const { rerender } = render(wrap(<ToolGroup tools={running} />));
    const toggle = screen.getByRole('button', { name: /0\/2 complete · 2 running/i });
    fireEvent.click(toggle);

    rerender(wrap(<ToolGroup tools={[makeTool('t1', true), makeTool('t2', true)]} />));
    expect(
      screen.getByRole('button', { name: /2 tool calls/i }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('preserves failed and image-only completion status in its summary dots', () => {
    const tools = [
      { ...makeTool('failed', true), toolError: true },
      {
        ...makeTool('image', false),
        toolResultImages: [{ id: 'image-1', mediaType: 'image/png' }],
      },
    ];
    const { container } = render(wrap(<ToolGroup tools={tools} />));
    expect(screen.getByRole('button', { name: /2 tool calls · 1 failed/i })).toBeTruthy();
    expect(container.querySelector('.tool-pill-dot--error')).toBeTruthy();
    expect(container.querySelectorAll('.tool-pill-dot--done')).toHaveLength(1);
  });

  it('shows running progress when not all done', () => {
    const tools = [makeTool('t1', true), makeTool('t2', false), makeTool('t3', false)];
    render(wrap(<ToolGroup tools={tools} />));
    expect(screen.getByText('1/3 complete · 2 running')).toBeTruthy();
  });

  it('shows +N when more than 8 tools', () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeTool(`t${i}`, true));
    render(wrap(<ToolGroup tools={tools} />));
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
