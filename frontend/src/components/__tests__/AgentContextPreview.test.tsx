// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentContextPreview } from '../AgentContextPreview';
import type { CompiledAgentContext } from '@mitzo/protocol';
afterEach(cleanup);
it('discloses exact source pins, omitted sections and included content for pack previews', () => {
  const value = {
    source: 'packs',
    compilerRevision: 'compiler-2',
    recipeHash: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
    provenance: {
      packs: [{ id: 'review', revision: 3, hash: 'c'.repeat(64) }],
      documents: [
        {
          storeId: 'accepted',
          path: 'hub/review.md',
          revision: 'd'.repeat(40),
          contentHash: 'e'.repeat(64),
        },
      ],
      omissions: [{ path: 'hub/review.md', heading: 'Background', reason: 'excluded' }],
    },
    context: {
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: 1,
      tokenCount: 123,
      tokenBudget: 4000,
      sources: [{ path: 'hub/review.md', kind: 'reference' }],
      included: [
        {
          source: 'hub/review.md',
          heading: 'Rules',
          tokens: 123,
          content: 'Review accepted sources',
        },
      ],
      trimmed: [],
      fullMarkdown: 'Review accepted sources',
    },
  } as CompiledAgentContext;
  render(<AgentContextPreview value={value} />);
  fireEvent.click(screen.getByText('Sources and trimming'));
  expect(screen.getByText('review · revision 3')).toBeTruthy();
  expect(screen.getByText(/Background · excluded/)).toBeTruthy();
  expect(screen.getByText('compiler-2')).toBeTruthy();
  expect(screen.getByText(/Each new chat saves this exact compiled result/)).toBeTruthy();
});
it.each(['workspace', 'contexgin'] as const)(
  'discloses the preview scope for legacy %s recipes',
  (source) => {
    const value = {
      source,
      compilerRevision: 'compiler-1',
      recipeHash: 'a'.repeat(64),
      payloadHash: 'b'.repeat(64),
      context: {
        type: 'boot_context',
        source: 'contexgin',
        sourceCount: 1,
        tokenCount: 123,
        tokenBudget: 4000,
        sources: [{ path: 'README.md', kind: 'reference' }],
        included: [],
        trimmed: [],
        fullMarkdown: 'Sample workspace context',
      },
    } as CompiledAgentContext;
    render(<AgentContextPreview value={value} />);
    if (source === 'workspace') {
      expect(screen.getByText(/configured sample workspace/)).toBeTruthy();
      expect(screen.getByText(/New chats compile their own task workspace/)).toBeTruthy();
      expect(screen.getByText(/resumes keep the saved recipe/)).toBeTruthy();
    } else {
      expect(screen.getByText(/Sandbox chats use its configured sandbox recipe/)).toBeTruthy();
      expect(screen.getByText(/sources can differ from this preview/)).toBeTruthy();
    }
    expect(screen.queryByText(/Each new chat saves this exact compiled result/)).toBeNull();
  },
);
