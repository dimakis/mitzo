import { copyCallbackOutcome } from './turn-callbacks.js';
/** Product tools use the native dynamic-tool result surface. These are receipts,
 * not another tool executor or native history. Keep legacy text results intact. */
export type CodexToolContentItem =
  { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };
export interface CodexToolResult {
  content: string;
  isError: boolean;
  contentItems?: CodexToolContentItem[];
}
// Native completed-item notifications echo these bytes. Stay below the existing
// 4 MiB inbound frame ceiling, including notification/identity overhead.
export const MAX_CODEX_RICH_RESULT_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ITEMS = 32;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const invalid = () => new Error('Invalid or unsupported tool image output');
export class CodexToolResultBoundError extends Error {
  constructor() {
    super('Tool output exceeds the supported result bound');
  }
}

function imageDataUrl(data: unknown, mimeType: unknown): string {
  if (typeof mimeType !== 'string' || !imageTypes.has(mimeType) || typeof data !== 'string')
    throw invalid();
  if (data.length > MAX_CODEX_RICH_RESULT_BYTES) throw new CodexToolResultBoundError();
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw invalid();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw invalid();
  const signature =
    mimeType === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg'
        ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mimeType === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
          : bytes.length >= 12 &&
            bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
            bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!signature) throw invalid();
  return `data:${mimeType};base64,${data}`;
}

function nativeImageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CODEX_RICH_RESULT_BYTES) throw invalid();
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw invalid();
  return imageDataUrl(match[2], match[1]);
}

/** Validate on initial delivery AND database reads. Never fall back to a text
 * receipt when stored rich data is invalid, or accept a changed text projection. */
export function normalizeCodexToolResult(result: CodexToolResult): CodexToolResult {
  if (typeof result.content !== 'string' || typeof result.isError !== 'boolean') throw invalid();
  // Trusted adapters also carry private environment-change receipts. Preserve
  // those in memory; the store and native serializers select only public fields.
  if (result.contentItems === undefined)
    return copyCallbackOutcome(result, Object.freeze({ ...result }));
  if (!Array.isArray(result.contentItems) || result.contentItems.length > MAX_ITEMS)
    throw new CodexToolResultBoundError();
  if (Buffer.byteLength(result.content) > MAX_TEXT_BYTES) throw new CodexToolResultBoundError();
  let textBytes = 0;
  const contentItems = result.contentItems.map((item): CodexToolContentItem => {
    if (!item || typeof item !== 'object') throw invalid();
    if (item.type === 'inputText' && typeof item.text === 'string') {
      textBytes += Buffer.byteLength(item.text);
      if (textBytes > MAX_TEXT_BYTES) throw new CodexToolResultBoundError();
      return { type: 'inputText', text: item.text };
    }
    if (item.type === 'inputImage')
      return { type: 'inputImage', imageUrl: nativeImageUrl(item.imageUrl) };
    throw invalid();
  });
  const projection = contentItems
    .filter((item) => item.type === 'inputText')
    .map((item) => item.text)
    .join('\n');
  if (projection !== result.content) throw Error('Tool text projection changed');
  const copy = { content: result.content, isError: result.isError, contentItems };
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_CODEX_RICH_RESULT_BYTES)
    throw new CodexToolResultBoundError();
  contentItems.forEach(Object.freeze);
  Object.freeze(contentItems);
  return copyCallbackOutcome(result, Object.freeze({ ...result, ...copy }));
}

export function codexToolResultContentItems(result: CodexToolResult): CodexToolContentItem[] {
  const checked = normalizeCodexToolResult(result);
  return checked.contentItems ?? [{ type: 'inputText', text: checked.content }];
}

/** Text truncation is explicit, UTF-8 safe, and happens only before custody. */
function boundedText(text: string, remaining: number): string {
  if (Buffer.byteLength(text) <= remaining) return text;
  const marker = '\n[Output truncated]';
  if (remaining < Buffer.byteLength(marker)) throw new CodexToolResultBoundError();
  const bytes = Buffer.from(text);
  let end = remaining - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + marker;
}

/** Only inline image bytes cross this boundary. Resource links, audio and other
 * output types cannot trigger a network request or local file read. */
export function normalizeMcpToolResult(
  content: unknown,
  isError: boolean,
  projectText?: (text: string) => string,
): CodexToolResult {
  try {
    if (!Array.isArray(content)) {
      const text = JSON.stringify(content ?? '');
      return {
        content: projectText
          ? projectText(text)
          : text.length > 65536
            ? text.slice(0, 65536) + '\n[Output truncated]'
            : text,
        isError,
      };
    }
    const rich = content.some((block) => block?.type !== 'text');
    if (!rich) {
      const text = content
        .map((block) => {
          if (typeof block.text !== 'string') throw invalid();
          return block.text;
        })
        .join('\n');
      return {
        content: projectText
          ? projectText(text)
          : text.length > 65536
            ? text.slice(0, 65536) + '\n[Output truncated]'
            : text,
        isError,
      };
    }
    if (content.length > MAX_ITEMS) throw new CodexToolResultBoundError();
    let remaining =
      MAX_TEXT_BYTES - Math.max(0, content.filter((block) => block?.type === 'text').length - 1);
    const contentItems: CodexToolContentItem[] = content.map((block) => {
      if (!block || typeof block !== 'object') throw invalid();
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = boundedText(block.text, remaining);
        remaining -= Buffer.byteLength(text);
        return { type: 'inputText', text };
      }
      if (block.type === 'image')
        return { type: 'inputImage', imageUrl: imageDataUrl(block.data, block.mimeType) };
      throw invalid();
    });
    return normalizeCodexToolResult({
      content: contentItems
        .filter((item) => item.type === 'inputText')
        .map((item) => item.text)
        .join('\n'),
      isError,
      contentItems,
    });
  } catch (error) {
    return {
      content:
        error instanceof CodexToolResultBoundError
          ? 'Tool output exceeds the supported result bound. Request a smaller result.'
          : 'Tool returned invalid or unsupported image/content output. Request text or supported inline images.',
      isError: true,
    };
  }
}

export function appendCodexToolFeedback(result: CodexToolResult, context: string): CodexToolResult {
  const checked = normalizeCodexToolResult(result);
  if (!context) return checked;
  const feedback = `\n\nProject hook feedback:\n${context}`;
  if (!checked.contentItems)
    return { content: checked.content + feedback, isError: checked.isError };
  // Append to the last text block to keep the legacy content string exact.
  const items = checked.contentItems.map((item) => ({ ...item }));
  let lastText = -1;
  for (let index = 0; index < items.length; index++)
    if (items[index].type === 'inputText') lastText = index;
  if (lastText >= 0) (items[lastText] as { type: 'inputText'; text: string }).text += feedback;
  else items.push({ type: 'inputText', text: feedback });
  return normalizeCodexToolResult({
    ...checked,
    content: checked.content + feedback,
    contentItems: items,
  });
}
