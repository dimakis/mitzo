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

  describe('RawInputDetail', () => {
    it('returns null for read type (path shown in header)', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: 'test.py',
        toolResult: 'contents',
        rawInput: { type: 'read', path: '/src/test.py', language: 'python' },
      };
      render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      // RawInputDetail returns null for read, so no Input section
      expect(screen.queryByText('Input')).toBeNull();
    });

    it('renders CodeBlock for write type', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Write',
        toolInput: 'test.js',
        toolResult: 'done',
        rawInput: {
          type: 'write',
          path: '/src/test.js',
          contents: 'console.log("test");',
          language: 'javascript',
        },
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('/src/test.js')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight')).toBeTruthy();
    });

    it('renders diff CodeBlocks for diff type', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Edit',
        toolInput: 'test.py',
        toolResult: 'done',
        rawInput: {
          type: 'diff',
          path: '/src/test.py',
          old_string: 'old code',
          new_string: 'new code',
          language: 'python',
        },
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('/src/test.py')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight--removed')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight--added')).toBeTruthy();
    });

    it('renders bash CodeBlock for command type', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Bash',
        toolInput: 'ls',
        toolResult: 'file1.txt\nfile2.txt',
        rawInput: { type: 'command', command: 'ls -la' },
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Command')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight')).toBeTruthy();
    });
  });

  describe('ToolResult', () => {
    it('renders syntax-highlighted output for read type', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: 'main.py',
        toolResult: 'def hello():\n    print("world")',
        rawInput: { type: 'read', path: '/src/main.py', language: 'python' },
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('/src/main.py')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight')).toBeTruthy();
    });

    it('renders plain pre for non-read tools', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Grep',
        toolInput: 'search term',
        toolResult: 'file1.txt:10:match\nfile2.txt:20:match',
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Result')).toBeTruthy();
      expect(container.querySelector('.tool-pill-pre')).toBeTruthy();
      expect(container.querySelector('.code-block-highlight')).toBeNull();
    });

    it('returns null when no toolResult', () => {
      const block: FinishedBlock = {
        blockId: 'b1',
        blockType: 'tool_use',
        content: '',
        toolName: 'Read',
        toolInput: 'test.py',
      };
      const { container } = render(wrap(<ToolPill block={block} />));
      fireEvent.click(screen.getByRole('button'));

      expect(screen.queryByText('Result')).toBeNull();
      expect(container.querySelector('.code-block-highlight')).toBeNull();
    });
  });
});
