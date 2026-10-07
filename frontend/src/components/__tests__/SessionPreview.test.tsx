// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionPreview } from '../SessionPreview';

const session = { id: 'one', summary: 'Review UI', lastModified: 30 };
const props = { session, onClose: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}
function message(content: string, blockType = 'text', role = 'assistant') {
  return { messageId: content, role, blocks: [{ blockId: content, content, blockType }] };
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('loads only when mounted and displays the latest three text messages without tool/thinking content', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response([
        message('Old answer'),
        message('Recent question', 'text', 'user'),
        message('Private reasoning', 'thinking'),
        message('Tool details', 'tool_use'),
        message('Recent answer'),
        message('Latest answer'),
      ]),
    ),
  );
  render(<SessionPreview {...props} />);
  await act(async () => {});
  expect(screen.queryByText('Old answer')).toBeNull();
  expect(screen.queryByText('Private reasoning')).toBeNull();
  expect(screen.queryByText('Tool details')).toBeNull();
  expect(screen.getByText('Recent question')).toBeTruthy();
  expect(screen.getByText('Latest answer')).toBeTruthy();
});
it('keeps actions available while loading and aborts its history request on dismissal', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  const view = render(<SessionPreview {...props} />);
  expect(screen.getByText('Loading preview…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
  const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
it.each([response([], true), response({}, false)])(
  'handles empty and unavailable history',
  async (result) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => result),
    );
    render(<SessionPreview {...props} />);
    await act(async () => {});
    expect(
      screen.getByText(result.ok ? 'No saved messages yet.' : 'Couldn’t load preview.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(props.onOpen).toHaveBeenCalledOnce();
  },
);
it('reports a failed copy without claiming success', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([])),
  );
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: vi.fn(async () => {
        throw new Error('denied');
      }),
    },
  });
  render(<SessionPreview {...props} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy session ID' }));
  });
  expect(screen.getByText('Couldn’t copy session ID.')).toBeTruthy();
});
it('dismisses from the backdrop and restores page scrolling on unmount', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  document.body.style.overflow = 'auto';
  const view = render(<SessionPreview {...props} />);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(screen.getByRole('dialog'));
  expect(props.onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.body.style.overflow).toBe('auto');
});
