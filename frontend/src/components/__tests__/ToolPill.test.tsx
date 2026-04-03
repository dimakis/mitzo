// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(() => cleanup());
import { ToolPill } from '../ToolPill';
import type { FinishedBlock } from '../../types/chat';

describe('ToolPill', () => {
  it('shows running state when no toolResult', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Read',
      toolInput: 'file.txt',
    };
    const { container } = render(<ToolPill block={block} />);
    expect(container.querySelector('.tool-pill--running')).toBeTruthy();
    expect(screen.getByText('Running...')).toBeTruthy();
  });

  it('shows done state with toolResult', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Read',
      toolInput: 'file.txt',
      toolResult: 'file contents',
    };
    const { container } = render(<ToolPill block={block} />);
    expect(container.querySelector('.tool-pill--done')).toBeTruthy();
  });

  it('toggles expanded state on click', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Read',
      toolInput: 'file.txt',
      toolResult: 'contents',
      rawInput: { type: 'write', path: '/a.txt', contents: 'hello' },
    };
    render(<ToolPill block={block} />);
    expect(screen.queryByText('/a.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('/a.txt')).toBeTruthy();
  });
});
