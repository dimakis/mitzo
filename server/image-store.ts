/**
 * In-memory store for tool result images.
 *
 * Images are stored server-side and served via REST endpoint.
 * WS events carry only image IDs — no base64 over the wire.
 */

import { randomUUID } from 'node:crypto';

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface StoredImage {
  data: Buffer;
  mediaType: string;
  sessionId: string;
  createdAt: number;
}

const images = new Map<string, StoredImage>();

/** Store an image and return its ID. Returns null if mediaType is not allowed. */
export function storeImage(
  sessionId: string,
  base64Data: string,
  mediaType: string,
): string | null {
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) return null;
  const id = randomUUID();
  images.set(id, {
    data: Buffer.from(base64Data, 'base64'),
    mediaType,
    sessionId,
    createdAt: Date.now(),
  });
  return id;
}

/** Retrieve an image by ID. Returns null if not found. */
export function getImage(imageId: string): StoredImage | null {
  return images.get(imageId) ?? null;
}

/** Remove all images for a session. Called on session cleanup. */
export function clearSessionImages(sessionId: string): number {
  let count = 0;
  for (const [id, img] of images) {
    if (img.sessionId === sessionId) {
      images.delete(id);
      count++;
    }
  }
  return count;
}
