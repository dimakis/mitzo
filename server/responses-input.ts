import type { ConversationMessage } from '@mitzo/harness';

const supportedMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxImageBytes = 10 * 1024 * 1024;

/** Convert Mitzo attachments to validated provider-neutral user content. */
export function responsesUserContent(
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
): ConversationMessage['content'] {
  if (!images?.length) return prompt;
  const content: Exclude<ConversationMessage['content'], string> = [];
  if (prompt) content.push({ type: 'text', text: prompt });
  for (const image of images) {
    if (!supportedMediaTypes.has(image.mediaType)) {
      throw new Error('Unsupported image media type for API chat');
    }
    const data = image.data;
    if (typeof data !== 'string' || !data.length || data.length % 4 !== 0) {
      throw new Error('API image data must be valid nonempty base64');
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const decodedBytes = (data.length / 4) * 3 - padding;
    if (decodedBytes > maxImageBytes) throw new Error('API images must be at most 10 MiB each');
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      Buffer.from(data, 'base64').toString('base64') !== data
    ) {
      throw new Error('API image data must be valid nonempty base64');
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data },
    });
  }
  return content;
}
