// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { createCollaborationProjection } from '@mitzo/client';
import type { FinishedMessage, StreamingMessage } from '@mitzo/protocol';
import { CollaborationTranscript } from '../CollaborationTranscript';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('does not write the shared transcript scroll position when only the composer draft changes', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const projection = createCollaborationProjection(sharedConversationView());
  const messages: FinishedMessage[] = [];
  const scrollRef = { current: null as HTMLDivElement | null };
  const stream = (content: string): StreamingMessage => ({
    messageId: 'live-source',
    blocks: new Map([['body', { blockId: 'body', blockType: 'text', content, done: false }]]),
    blockOrder: ['body'],
  });
  function Surface({ current }: { current: StreamingMessage }) {
    const [draft, setDraft] = useState('');
    return (
      <MemoryRouter>
        <CollaborationTranscript
          projection={projection}
          scrollRef={scrollRef}
          ordinary={{
            sessionId: 'architect',
            messages,
            current,
            running: true,
            permission: null,
            onPermissionRespond: () => {},
          }}
        />
        <textarea
          aria-label="Composer draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </MemoryRouter>
    );
  }
  const first = stream('Checking the composer');
  const ui = render(<Surface current={first} />);
  const el = scrollRef.current!;
  const writes: number[] = [];
  let top = 1500;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 500 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writes.push(value);
        top = value;
      },
    },
  });
  for (const value of ['I', 'I am', 'I am typing'])
    fireEvent.change(screen.getByLabelText('Composer draft'), { target: { value } });
  expect(writes).toEqual([]);
  expect(top).toBe(1500);
  ui.rerender(<Surface current={stream('Checking the composer and its scrolling')} />);
  expect(writes).toEqual([2000]);
  top = 600;
  writes.length = 0;
  fireEvent.scroll(el);
  fireEvent.change(screen.getByLabelText('Composer draft'), {
    target: { value: 'Keep reading this earlier reply' },
  });
  ui.rerender(<Surface current={stream('More live work while the reader stays in history')} />);
  expect(writes).toEqual([]);
  expect(top).toBe(600);
});
