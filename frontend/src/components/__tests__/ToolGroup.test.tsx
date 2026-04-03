// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolGroup } from '../ToolGroup';
import type { FinishedBlock } from '../../types/chat';

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
});

describe('ToolGroup', () => {
  it('shows tool count label when all done', () => {
    const tools = [makeTool('t1', true), makeTool('t2', true), makeTool('t3', true)];
    render(<ToolGroup tools={tools} />);
    expect(screen.getByText('3 tool calls')).toBeTruthy();
  });

  it('shows running progress when not all done', () => {
    const tools = [makeTool('t1', true), makeTool('t2', false), makeTool('t3', false)];
    render(<ToolGroup tools={tools} />);
    expect(screen.getByText('1/3 running...')).toBeTruthy();
  });

  it('shows +N when more than 8 tools', () => {
    const tools = Array.from({ length: 10 }, (_, i) => makeTool(`t${i}`, true));
    render(<ToolGroup tools={tools} />);
    expect(screen.getByText('+2')).toBeTruthy();
  });
});
