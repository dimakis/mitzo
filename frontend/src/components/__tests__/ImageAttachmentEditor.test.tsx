// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageAttachmentEditor } from '../ImageAttachmentEditor';
import type { ImageAttachment } from '../../types/chat';
const mocks = vi.hoisted(() => ({ export: vi.fn() }));
vi.mock('../../lib/image-markup', async (original) => ({
  ...(await original<typeof import('../../lib/image-markup')>()),
  exportImageMarkup: mocks.export,
}));

const image: ImageAttachment = {
  data: 'original',
  mediaType: 'image/jpeg',
  preview: 'data:image/jpeg;base64,original',
};
const saved: ImageAttachment = {
  data: 'edited',
  mediaType: 'image/png',
  preview: 'data:image/png;base64,edited',
};

beforeEach(() => {
  mocks.export.mockReset().mockResolvedValue(saved);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ready() {
  const original = screen.getByAltText('Attached image');
  Object.defineProperties(original, {
    naturalWidth: { value: 1000 },
    naturalHeight: { value: 500 },
  });
  fireEvent.load(original);
  const drawing = screen.getByLabelText('Image drawing surface');
  vi.spyOn(drawing, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 200,
    height: 100,
  } as DOMRect);
  return { original, drawing };
}
function draw(drawing: HTMLElement) {
  fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
  fireEvent.pointerDown(drawing, { clientX: 50, clientY: 40, button: 0 });
  fireEvent.pointerMove(drawing, { clientX: 170, clientY: 80 });
  fireEvent.pointerUp(drawing, { clientX: 170, clientY: 80 });
}

describe('ImageAttachmentEditor', () => {
  it('opens the shared full-screen dialog and waits for a loaded image before saving', () => {
    render(<ImageAttachmentEditor image={image} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog').classList.contains('image-attachment-editor')).toBe(true);
    expect((screen.getByRole('button', { name: 'Save image' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    ready();
    expect((screen.getByRole('button', { name: 'Save image' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('supports drawing, semantic color selection, undo and clear without altering the original', () => {
    const onSave = vi.fn();
    render(<ImageAttachmentEditor image={image} onSave={onSave} onClose={vi.fn()} />);
    const { drawing } = ready();
    draw(drawing);
    expect(drawing.querySelectorAll('[data-markup-stroke]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Draw' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Red pen' }));
    expect(screen.getByRole('button', { name: 'Red pen' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(drawing.querySelectorAll('[data-markup-stroke]')).toHaveLength(0);
    fireEvent.pointerDown(drawing, { clientX: 50, clientY: 40, button: 0 });
    fireEvent.pointerUp(drawing, { clientX: 50, clientY: 40 });
    expect(drawing.querySelectorAll('[data-markup-stroke]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear drawing' }));
    expect(drawing.querySelectorAll('[data-markup-stroke]')).toHaveLength(0);
    expect(onSave).not.toHaveBeenCalled();
    expect(image.data).toBe('original');
  });

  it('keeps the primary stroke active when a secondary pointer loses capture', () => {
    render(<ImageAttachmentEditor image={image} onSave={vi.fn()} onClose={vi.fn()} />);
    const { drawing } = ready();
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    const pointer = (
      type: string,
      pointerId: number,
      clientX: number,
      clientY: number,
      isPrimary = true,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: 0,
      });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        isPrimary: { value: isPrimary },
      });
      fireEvent(drawing, event);
    };
    pointer('pointerdown', 1, 50, 40);
    pointer('pointerdown', 2, 70, 50, false);
    pointer('lostpointercapture', 2, 70, 50, false);
    pointer('pointermove', 1, 170, 80);
    pointer('pointerup', 1, 170, 80);
    expect(drawing.querySelectorAll('[data-markup-stroke]')).toHaveLength(1);
    expect(drawing.querySelector('polyline')?.getAttribute('points')).toBe('200,100 800,300');
  });

  it('exports edited attachment bytes only on Save and blocks repeated saves while exporting', async () => {
    let finish!: (value: ImageAttachment) => void;
    mocks.export.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onSave = vi.fn();
    render(<ImageAttachmentEditor image={image} onSave={onSave} onClose={vi.fn()} />);
    const { drawing, original } = ready();
    draw(drawing);
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
    expect(mocks.export).toHaveBeenCalledWith(original, [
      expect.objectContaining({
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.6 },
        ],
      }),
    ]);
    expect(onSave).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Saving image…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => finish(saved));
    expect(onSave).toHaveBeenCalledWith(saved);
  });

  it('keeps edits and the original safe on export failure and allows a retry', async () => {
    mocks.export.mockRejectedValueOnce(new Error('canvas unavailable'));
    const onSave = vi.fn();
    render(<ImageAttachmentEditor image={image} onSave={onSave} onClose={vi.fn()} />);
    draw(ready().drawing);
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not save/i);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(saved));
  });

  it('discards on Close or Escape and stops composer keyboard events', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const composerKey = vi.fn();
    render(
      <div onKeyDown={composerKey}>
        <ImageAttachmentEditor image={image} onSave={onSave} onClose={onClose} />
      </div>,
    );
    draw(ready().drawing);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Save image' }), { key: 'Enter' });
    expect(composerKey).not.toHaveBeenCalled();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not deliver a save after the user closes during export', async () => {
    let finish!: (value: ImageAttachment) => void;
    mocks.export.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onSave = vi.fn();
    const onClose = vi.fn();
    const view = render(<ImageAttachmentEditor image={image} onSave={onSave} onClose={onClose} />);
    draw(ready().drawing);
    fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    view.unmount();
    await act(async () => finish(saved));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a load error and keeps Save unavailable', () => {
    render(<ImageAttachmentEditor image={image} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.error(screen.getByAltText('Attached image'));
    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    expect((screen.getByRole('button', { name: 'Save image' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
