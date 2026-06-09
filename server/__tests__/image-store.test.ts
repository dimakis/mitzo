import { describe, it, expect, beforeEach } from 'vitest';
import { storeImage, getImage, clearSessionImages, _resetForTest } from '../image-store.js';

describe('image-store', () => {
  const SESSION = 'test-session';

  beforeEach(() => {
    _resetForTest();
  });

  it('stores and retrieves an image', () => {
    const id = storeImage(SESSION, 'aGVsbG8=', 'image/png');
    expect(id).toBeTruthy();
    const img = getImage(id!);
    expect(img).not.toBeNull();
    expect(img!.mediaType).toBe('image/png');
    expect(img!.sessionId).toBe(SESSION);
    expect(img!.data).toBeInstanceOf(Buffer);
  });

  it('rejects non-image media types', () => {
    expect(storeImage(SESSION, 'data', 'text/html')).toBeNull();
    expect(storeImage(SESSION, 'data', 'application/json')).toBeNull();
    expect(storeImage(SESSION, 'data', 'video/mp4')).toBeNull();
  });

  it('accepts all supported image types', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      const id = storeImage(SESSION, 'dGVzdA==', type);
      expect(id).toBeTruthy();
      expect(getImage(id!)!.mediaType).toBe(type);
    }
  });

  it('returns null for unknown image ID', () => {
    expect(getImage('nonexistent-id')).toBeNull();
  });

  it('clears images by session', () => {
    const s1 = 'session-1';
    const s2 = 'session-2';
    const id1 = storeImage(s1, 'YQ==', 'image/png')!;
    const id2 = storeImage(s2, 'Yg==', 'image/png')!;

    const cleared = clearSessionImages(s1);
    expect(cleared).toBe(1);
    expect(getImage(id1)).toBeNull();
    expect(getImage(id2)).not.toBeNull();
  });

  it('rejects images exceeding 10 MB', () => {
    // Create base64 string that decodes to >10 MB
    const bigData = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(storeImage(SESSION, bigData, 'image/png')).toBeNull();
  });
});
