import type { ImageAttachment } from '../types/chat';

export interface ImageMarkupPoint {
  x: number;
  y: number;
}
export interface ImageMarkupStroke {
  color: string;
  points: ImageMarkupPoint[];
}

export function normalizedImagePoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): ImageMarkupPoint | null {
  if (rect.width <= 0 || rect.height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY))
    return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

/** Drawing geometry is proportional to the original pixels, independent of the preview size. */
export function imageMarkupLineWidth(width: number, height: number): number {
  return Math.max(1, Math.min(width, height) * 0.006);
}

/** Export into a fresh image; the original attachment is never modified. */
export async function exportImageMarkup(
  original: HTMLImageElement,
  strokes: ImageMarkupStroke[],
): Promise<ImageAttachment> {
  const { naturalWidth: width, naturalHeight: height } = original;
  if (!width || !height) throw new Error('Image has not loaded');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image export is unavailable');
  context.drawImage(original, 0, 0, width, height);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = imageMarkupLineWidth(width, height);
  for (const stroke of strokes) {
    const first = stroke.points[0];
    if (!first) continue;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.beginPath();
    if (stroke.points.length === 1) {
      context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x * width, first.y * height);
      for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Image export failed'))),
      'image/png',
    );
  });
  if (blob.size > 10 * 1024 * 1024)
    throw new Error('The edited image exceeds the 10 MiB attachment limit');
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Image export failed'));
    reader.onerror = () => reject(new Error('Image export failed'));
    reader.readAsDataURL(blob);
  });
  const data = preview.split(',')[1];
  if (!data || !preview.startsWith('data:image/png;base64,'))
    throw new Error('Image export failed');
  return { data, mediaType: 'image/png', preview };
}
