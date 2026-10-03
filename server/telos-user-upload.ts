import { z } from 'zod';
import { extname } from 'node:path';
import { artifactFilename, MAX_TELOS_ARTIFACT_BYTES } from './telos-artifact-store.js';

export const TelosUserUploadInput = z
  .object({
    filename: artifactFilename,
    title: z.string().trim().min(1).max(200),
    requestId: z.string().min(1).max(200),
    base64: z.string().max(4 * Math.ceil(MAX_TELOS_ARTIFACT_BYTES / 3) + 4),
  })
  .strict();

/** Uploads remain opaque, attachment-only bytes. Extension checks do not constitute malware scanning. */
export function validateUserUpload(filename: string, bytes: Buffer): boolean {
  const extension = extname(filename).toLowerCase();
  if (['.txt', '.md', '.csv', '.json'].includes(extension)) {
    return !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
  }
  if (extension === '.pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (extension === '.png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (['.jpg', '.jpeg'].includes(extension))
    return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (extension === '.webp')
    return (
      bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
    );
  if (['.docx', '.xlsx'].includes(extension))
    return bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  return false;
}
