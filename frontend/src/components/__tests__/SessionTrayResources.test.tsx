// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { FinishedMessage, StreamingMessage } from '../../types/chat';

const { collectSessionResources, mergeSessionResources } = vi.hoisted(() => ({
  collectSessionResources: vi.fn((_messages?: unknown[], _current?: unknown) => ({
    sources: [],
    outputs: [],
  })),
  mergeSessionResources: vi.fn(() => ({ sources: [], outputs: [] })),
}));

vi.mock('../../lib/session-resources', () => ({ collectSessionResources, mergeSessionResources }));
vi.mock('../ContextPanel', () => ({ ContextPanel: () => null }));
vi.mock('../SessionBanner', () => ({ SessionBanner: () => null }));

import { SessionTray } from '../SessionTray';

afterEach(() => {
  cleanup();
  collectSessionResources.mockClear();
});

describe('SessionTray resource collection', () => {
  it('does not rescan finished history when only the streaming message changes', () => {
    const messages: FinishedMessage[] = [
      {
        messageId: 'assistant-1',
        role: 'assistant',
        blocks: [{ blockId: 'a1', blockType: 'text', content: 'Finished' }],
      },
    ];
    const current = (content: string): StreamingMessage => ({
      messageId: 'current',
      blockOrder: ['streaming'],
      blocks: new Map([
        ['streaming', { blockId: 'streaming', blockType: 'text', content, done: false }],
      ]),
    });
    const baseProps = {
      selectedContextBlocks: [],
      draftImages: [],
      onToggleContextBlock: vi.fn(),
      onAddImages: vi.fn(),
      onRemoveImage: vi.fn(),
    };

    const { rerender } = render(
      <SessionTray {...baseProps} messages={messages} current={current('one')} />,
    );
    rerender(<SessionTray {...baseProps} messages={messages} current={current('two')} />);

    expect(
      collectSessionResources.mock.calls.filter(([history]) => history === messages),
    ).toHaveLength(1);
  });
});
