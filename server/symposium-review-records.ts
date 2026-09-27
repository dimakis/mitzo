import { createHash } from 'node:crypto';

/** Export is metadata stored on the host, never a file added to the reviewed Git tree. */
export const MAX_REVIEW_RECORD_BYTES = 1024 * 1024;
export function canonicalReviewJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReviewJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalReviewJson(object[key])}`)
      .join(',')}}`;
  }
  throw new Error('Review record contains unsupported data');
}
export function reviewRecordHash(payload: string): string {
  if (Buffer.byteLength(payload, 'utf8') > MAX_REVIEW_RECORD_BYTES)
    throw new Error('Review record exceeds the export size limit');
  return createHash('sha256').update(payload).digest('hex');
}
