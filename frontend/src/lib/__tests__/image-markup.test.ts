// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportImageMarkup, normalizedImagePoint, type ImageMarkupStroke } from '../image-markup';

afterEach(() => vi.restoreAllMocks());

describe('image markup', () => {
  it('normalizes and bounds pointer coordinates to the actual fitted image', () => {
    const rect = { left: 20, top: 50, width: 200, height: 100 };
    expect(normalizedImagePoint(120, 75, rect)).toEqual({ x: 0.5, y: 0.25 });
    expect(normalizedImagePoint(-10, 900, rect)).toEqual({ x: 0, y: 1 });
    expect(normalizedImagePoint(20, 50, { ...rect, width: 0 })).toBeNull();
  });

  it('composites normalized lines and single-point marks over the full-resolution original as PNG', async () => {
    const original = document.createElement('img');
    Object.defineProperties(original, {
      naturalWidth: { value: 1000 },
      naturalHeight: { value: 500 },
    });
    const context = {
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      lineWidth: 0,
      strokeStyle: '',
      fillStyle: '',
      lineCap: '',
      lineJoin: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    const png = new Blob(['composite'], { type: 'image/png' });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
    ) {
      expect(this.width).toBe(1000);
      expect(this.height).toBe(500);
      callback(png);
    });
    const strokes: ImageMarkupStroke[] = [
      {
        color: 'rgb(255, 0, 0)',
        points: [
          { x: 0.2, y: 0.4 },
          { x: 0.8, y: 0.6 },
        ],
      },
      { color: 'rgb(0, 0, 255)', points: [{ x: 0.1, y: 0.2 }] },
    ];
    const result = await exportImageMarkup(original, strokes);
    expect(context.drawImage).toHaveBeenCalledWith(original, 0, 0, 1000, 500);
    expect(context.moveTo).toHaveBeenCalledWith(200, 200);
    expect(context.lineTo).toHaveBeenCalledWith(800, 300);
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(context.arc).toHaveBeenCalledWith(100, 100, expect.any(Number), 0, Math.PI * 2);
    expect(context.fill).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(result).toEqual({
      data: btoa('composite'),
      mediaType: 'image/png',
      preview: `data:image/png;base64,${btoa('composite')}`,
    });
  });

  it('reports export failures without producing replacement bytes', async () => {
    const original = document.createElement('img');
    Object.defineProperties(original, {
      naturalWidth: { value: 10 },
      naturalHeight: { value: 10 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await expect(exportImageMarkup(original, [])).rejects.toThrow(/image/i);
  });
});
