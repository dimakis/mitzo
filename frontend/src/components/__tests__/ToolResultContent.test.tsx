// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToolResultContent } from '../ToolResultContent';
import { ToolPill } from '../ToolPill';

const copy = vi.fn();
vi.mock('../../hooks/useCopyFeedback', () => ({
  useCopyFeedback: () => ({ copied: false, copy }),
}));
afterEach(() => {
  cleanup();
  copy.mockClear();
});

describe('readable tool results', () => {
  it('separates the field label from its preview in the accessible button name', () => {
    render(<ToolResultContent text={'{"commit":{"message":"Fix wrapping"}}'} />);
    expect(screen.getByRole('button', { name: 'Commit Fix wrapping' })).toBeTruthy();
  });
  it('shows labelled fields, preserves false/zero/null/empty strings, and opens nested records', () => {
    render(
      <ToolResultContent
        text={JSON.stringify({
          total_count: 0,
          ok: false,
          empty: '',
          missing: null,
          commit: { message: 'Fix wrapping' },
        })}
      />,
    );
    expect(screen.getByText('Total count')).toBeTruthy();
    for (const text of ['0', 'false', 'Empty string', 'null'])
      expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText('Message')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Commit/ }));
    expect(screen.getByText('Message')).toBeTruthy();
    expect(screen.getByText('Fix wrapping', { selector: 'dd' })).toBeTruthy();
  });

  it('keeps Raw and Copy faithful to the original, including large numeric IDs', () => {
    const text = '{"id":9007199254740993,"name":"Example"}';
    render(<ToolResultContent text={text} />);
    expect(screen.getByText('9007199254740993')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(copy).toHaveBeenCalledWith(text);
  });

  it('bounds initial list rendering and keeps later records reachable', () => {
    render(
      <ToolResultContent
        text={JSON.stringify(Array.from({ length: 23 }, (_, i) => ({ title: `Record ${i + 1}` })))}
      />,
    );
    expect(screen.queryByRole('button', { name: /Record 23/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    fireEvent.click(screen.getByRole('button', { name: /Record 23/ }));
    expect(screen.getByText('Record 23', { selector: 'dd' })).toBeTruthy();
  });

  it.each(['[]', '{}', '[]\ntruncated', 'command output\nnext line', '<script>alert(1)</script>'])(
    'keeps empty or non-JSON content readable: %s',
    (text) => {
      const { container } = render(<ToolResultContent text={text} />);
      expect(container.textContent).toContain(
        text === '[]' ? 'No items' : text === '{}' ? 'No fields' : text,
      );
      expect(container.querySelector('script')).toBeNull();
    },
  );

  it('uses the readable renderer for generic tool inputs/results, retaining source-file rendering', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ToolPill
          block={{
            blockId: 'one',
            blockType: 'tool_use',
            content: '',
            toolName: 'GitHubRead',
            toolInput: '{"endpoint":"/repos/example/commits"}',
            toolResult: '{"total_count":3}',
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /GitHubRead/ }));
    expect(screen.getByText('Endpoint')).toBeTruthy();
    expect(screen.getByText('Total count')).toBeTruthy();
    rerender(
      <MemoryRouter>
        <ToolPill
          block={{
            blockId: 'one',
            blockType: 'tool_use',
            content: '',
            toolName: 'Read',
            rawInput: { type: 'read', path: '/example.json', language: 'json' },
            toolResult: '{"total_count":3}',
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('/example.json')).toBeTruthy();
    expect(screen.queryByText('Total count')).toBeNull();
  });
});
