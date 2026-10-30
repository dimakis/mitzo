import { createHash } from 'node:crypto';

export const TOOL_OUTPUT_PREVIEW_BYTES = 8192;
export const TOOL_OUTPUT_RETAIN_BYTES = 4 * 1024 * 1024;
export const TOOL_OUTPUT_PAGE_MIN_BYTES = 128;
export const TOOL_OUTPUT_PAGE_MAX_BYTES = 4096;
export const TOOL_OUTPUT_PAGE_DEFAULT_BYTES = 2048;

/** UTF-8 boundaries keep excerpts valid even for non-English output. */
export function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text.slice(0, bytes + 1));
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

export function projectToolOutput(text: string, retain: (text: string) => string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= TOOL_OUTPUT_PREVIEW_BYTES) return text;
  // Never pretend a preview is complete JSON or silently discard an oversized result.
  const retained = bytes <= TOOL_OUTPUT_RETAIN_BYTES;
  let outputId: string | undefined;
  try {
    if (retained) outputId = retain(text);
  } catch {
    /* An executed effect must never be replayed because retention failed. */
  }
  let excerptBytes = 2800;
  const buffer = Buffer.from(text.slice(-2800));
  const encode = () => {
    let start = Math.max(0, buffer.length - excerptBytes);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    return JSON.stringify({
      format: 'tool-output-preview',
      complete: false,
      totalBytes: bytes,
      ...(retained ? { sha256: createHash('sha256').update(text).digest('hex') } : {}),
      ...(outputId
        ? {
            outputId,
            nextAction:
              'Use ReadToolOutput only for missing evidence; add a literal query or follow nextOffset.',
            read: {
              tool: 'ReadToolOutput',
              arguments: { outputId, offset: 0, limit: TOOL_OUTPUT_PAGE_DEFAULT_BYTES },
              maxLimit: TOOL_OUTPUT_PAGE_MAX_BYTES,
            },
          }
        : {
            retention: retained ? 'unavailable' : 'too_large',
            nextAction:
              'Full output is unavailable. Inspect current state with a narrower read; do not repeat an effect to recover its output.',
          }),
      head: utf8Prefix(text, excerptBytes),
      tail: buffer.subarray(start).toString('utf8'),
    });
  };
  let preview = encode();
  while (Buffer.byteLength(preview) > TOOL_OUTPUT_PREVIEW_BYTES) {
    excerptBytes = Math.floor(excerptBytes / 2);
    preview = encode();
  }
  return preview;
}

export function readToolOutputPage(
  text: string,
  input: { offset: number; limit: number; query?: string },
) {
  // Character cursors are UTF-16 offsets, matching JavaScript string slicing.
  let offset = input.offset;
  if (input.query) {
    offset = text.indexOf(input.query, offset);
    if (offset < 0) return { found: false, nextOffset: null, totalCharacters: text.length };
  }
  if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '')) offset--;
  let bytes = input.limit;
  const page = () => {
    const content = utf8Prefix(text.slice(offset), bytes);
    const end = offset + content.length;
    return {
      content,
      offset,
      nextOffset: end < text.length ? end : null,
      totalCharacters: text.length,
    };
  };
  let result = page();
  while (Buffer.byteLength(JSON.stringify(result)) > TOOL_OUTPUT_PREVIEW_BYTES) {
    bytes = Math.floor(bytes / 2);
    result = page();
  }
  return result;
}
