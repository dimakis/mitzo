// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

afterEach(() => cleanup());
import { ToolPill } from '../ToolPill';
import type { FinishedBlock } from '../../types/chat';

function wrap(ui: React.ReactElement) {
  return <MemoryRouter>{ui}</MemoryRouter>;
}

describe('ToolPill', () => {
  it('shows running state when no toolResult', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Read',
      toolInput: 'file.txt',
    };
    const { container } = render(wrap(<ToolPill block={block} />));
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
    const { container } = render(wrap(<ToolPill block={block} />));
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
    render(wrap(<ToolPill block={block} />));
    expect(screen.queryByText('/a.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('/a.txt')).toBeTruthy();
  });

  it('shows pop-out button for file-based tools when expanded', () => {
    const block: FinishedBlock = {
      blockId: 'b1',
      blockType: 'tool_use',
      content: '',
      toolName: 'Read',
      toolInput: 'main.py',
      toolResult: 'print("hello")',
      rawInput: { type: 'read', path: '/src/main.py', language: 'python' },
    };
    const { container } = render(wrap(<ToolPill block={block} />));

    // Expand
    fireEvent.click(screen.getByRole('button'));

    // Pop-out button should be present
    const popout = container.querySelector('[aria-label="Open in viewer"]');
    expect(popout).toBeTruthy();
  });
});
