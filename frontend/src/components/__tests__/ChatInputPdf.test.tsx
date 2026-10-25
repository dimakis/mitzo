// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import type { ImageAttachment } from '../../types/chat';
import { pdfToImages } from '../../lib/pdf-to-images';

vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../../lib/pdf-to-images', () => ({ pdfToImages: vi.fn() }));
const pages: ImageAttachment[] = [1, 2].map((page) => ({
  data: `page${page}`,
  mediaType: 'image/jpeg',
  preview: `data:image/jpeg;base64,page${page}`,
  name: `report.pdf — page ${page} of 2`,
}));
const props = { onSend: vi.fn(() => true), onStop: vi.fn(), running: false };
function attach(container: HTMLElement) {
  const input = container.querySelector('input[type=file]')!;
  fireEvent.change(input, {
    target: { files: [new File(['pdf'], 'report.pdf', { type: 'application/pdf' })] },
  });
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(pdfToImages).mockResolvedValue(pages);
});
afterEach(cleanup);

describe('PDF composer', () => {
  it('accepts PDFs, previews named pages and sends them through the image-capable transport', async () => {
    const { container } = render(<ChatInput {...props} />);
    const input = container.querySelector('input[type=file]')!;
    expect(input.getAttribute('accept')).toContain('application/pdf');
    expect(input.hasAttribute('capture')).toBe(false);
    attach(container);
    expect(await screen.findByAltText(pages[0].name!)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(props.onSend).toHaveBeenCalledWith(
      expect.stringContaining('report.pdf'),
      pages,
      undefined,
      expect.any(Function),
      expect.any(Function),
      {
        storageKey: 'mitzo-draft-new',
        revisionToken: expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
      },
    );
  });

  it('blocks keyboard and button sends until all pages have finished importing', async () => {
    let finish!: (value: ImageAttachment[]) => void;
    vi.mocked(pdfToImages).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container } = render(<ChatInput {...props} />);
    const text = screen.getByLabelText('Message Mitzo');
    fireEvent.change(text, { target: { value: 'Summarize this' } });
    attach(container);
    expect(
      (screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(props.onSend).not.toHaveBeenCalled();
    await act(async () => finish(pages));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(props.onSend).toHaveBeenCalledWith(
      expect.stringContaining('Summarize this'),
      pages,
      undefined,
      expect.any(Function),
      expect.any(Function),
      {
        storageKey: 'mitzo-draft-new',
        revisionToken: expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/),
      },
    );
  });

  it('shows import errors and preserves the text draft', async () => {
    vi.mocked(pdfToImages).mockRejectedValue(
      new Error('PDF has 15 pages; 10 page slots available.'),
    );
    const { container } = render(<ChatInput {...props} />);
    fireEvent.change(screen.getByLabelText('Message Mitzo'), {
      target: { value: 'keep my question' },
    });
    attach(container);
    expect((await screen.findByRole('alert')).textContent).toContain('15 pages');
    expect((screen.getByLabelText('Message Mitzo') as HTMLTextAreaElement).value).toBe(
      'keep my question',
    );
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('does not move completed PDF imports into a different session', async () => {
    let finish!: (value: ImageAttachment[]) => void;
    vi.mocked(pdfToImages).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container, rerender } = render(<ChatInput {...props} sessionId="one" />);
    attach(container);
    rerender(<ChatInput {...props} sessionId="two" />);
    await act(async () => finish(pages));
    expect(screen.queryByAltText(pages[0].name!)).toBeNull();
  });
});

it('keeps PDF filenames in saved drafts after reopening them', async () => {
  const { createChatDraft, getChatDraft } = await import('../../lib/chat-drafts');
  const draft = createChatDraft();
  const { container } = render(<ChatInput {...props} savedChatDraft={draft} />);
  attach(container);
  await screen.findByAltText(pages[0].name!);
  expect(getChatDraft(draft.id)?.images.map((image) => image.name)).toEqual(
    pages.map((image) => image.name),
  );
});
