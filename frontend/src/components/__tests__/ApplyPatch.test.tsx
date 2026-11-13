// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getRawInput, summarizeToolInput } from '@mitzo/protocol';
import { ToolPill } from '../ToolPill';

afterEach(cleanup);

const input = {
  changes: [
    {
      path: 'server/example.ts',
      kind: { type: 'update', move_path: null },
      diff: '@@ -1 +1 @@\n-const old = 1;\n+const next = 2;',
    },
    { path: 'new.py', kind: { type: 'add' }, diff: '+print("hello")' },
    { path: 'old.ts', kind: { type: 'delete' }, diff: '-export {};' },
  ],
};

describe('Codex ApplyPatch presentation', () => {
  it('renders every file as highlighted code with additions, removals and an honest result', () => {
    const { container } = render(
      <MemoryRouter>
        <ToolPill
          block={{
            blockId: 'patch',
            blockType: 'tool_use',
            content: '',
            toolName: 'ApplyPatch',
            toolInput: summarizeToolInput('ApplyPatch', input),
            rawInput: getRawInput('ApplyPatch', input),
            toolError: true,
            toolResult: 'File changes declined.',
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /ApplyPatch/ }));
    expect(screen.getByText('server/example.ts')).toBeTruthy();
    expect(screen.getByText('new.py')).toBeTruthy();
    expect(screen.getByText('old.ts')).toBeTruthy();
    expect(container.querySelector('.hljs-addition')?.textContent).toContain('+const next');
    expect(container.querySelector('.hljs-deletion')?.textContent).toContain('-const old');
    expect(screen.getByText('File changes declined.')).toBeTruthy();
    expect(container.querySelector('code')?.textContent).toBe(input.changes[0].diff);
    expect(screen.queryByText('Input')).toBeNull();
  });

  it('uses filenames in the collapsed summary', () => {
    expect(summarizeToolInput('ApplyPatch', input)).toBe(
      '3 files: server/example.ts, new.py, old.ts',
    );
  });

  it('bounds large diffs and explicitly marks the incomplete preview', () => {
    const raw = getRawInput('ApplyPatch', {
      changes: [{ ...input.changes[0], diff: '+x'.repeat(30000) }],
    });
    render(
      <MemoryRouter>
        <ToolPill
          block={{
            blockId: 'large',
            blockType: 'tool_use',
            content: '',
            toolName: 'ApplyPatch',
            rawInput: raw,
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /ApplyPatch/ }));
    expect(screen.getByText(/Patch preview truncated/)).toBeTruthy();
    expect(raw?.changes?.[0].diff).toHaveLength(50000);
  });

  it('shares the diff budget across files and bounds the number of file previews', () => {
    const raw = getRawInput('ApplyPatch', {
      changes: Array.from({ length: 101 }, () => ({ ...input.changes[0], diff: '+'.repeat(1000) })),
    });
    expect(raw?.changes).toHaveLength(100);
    expect(raw?.changes?.reduce((size, change) => size + change.diff.length, 0)).toBe(50000);
    expect(raw?.truncated).toBe(true);
  });

  it('keeps move destinations visible and treats code as text', () => {
    const raw = getRawInput('ApplyPatch', {
      changes: [
        {
          path: 'old.ts',
          kind: { type: 'update', move_path: 'renamed.ts' },
          diff: '+<img src=x onerror="alert(1)">',
        },
      ],
    });
    const { container } = render(
      <MemoryRouter>
        <ToolPill
          block={{
            blockId: 'move',
            blockType: 'tool_use',
            content: '',
            toolName: 'ApplyPatch',
            rawInput: raw,
          }}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /ApplyPatch/ }));
    expect(screen.getByText('Moved to renamed.ts')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('<img src=x');
  });

  it.each([{}, { changes: null }, { changes: [{ path: 'file.ts' }] }])(
    'retains the generic fallback for unsupported input %j',
    (value) => {
      expect(getRawInput('ApplyPatch', value)).toBeUndefined();
    },
  );
});
