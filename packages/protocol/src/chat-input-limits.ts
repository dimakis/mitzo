import { z } from 'zod';

const MiB = 1024 * 1024;
/** Product input budgets, shared by composer, admission and durable native queues. */
export const CHAT_MAX_IMAGES = 100;
export const CHAT_MAX_IMAGE_BYTES = 10 * MiB;
export const CHAT_MAX_IMAGE_BASE64_CHARS = 4 * Math.ceil(CHAT_MAX_IMAGE_BYTES / 3);
export const CHAT_MAX_ATTACHMENT_BYTES = 64 * MiB;
export const CHAT_MAX_TEXT_BYTES = 8 * MiB;
export const CHAT_MAX_PDF_BYTES = 50 * MiB;
// Includes base64, JSON escaping, retained intent and source/selection metadata.
export const CHAT_MAX_COMMAND_BYTES = 192 * MiB;
// Server-prepared prompts also contain source snapshots and application context.
export const CHAT_MAX_PREPARED_PROMPT_CHARS = 32 * MiB;
// Native item notifications echo the prepared prompt and separate saved-source
// (2 MiB) / continuity (64 KiB) text. JSON can escape each UTF-16 unit to six
// bytes. The final MiB covers source wrappers, image padding/URLs and RPC metadata.
const NATIVE_AUXILIARY_TEXT_BYTES = 2 * MiB + 64 * 1024;
export const CHAT_MAX_NATIVE_FRAME_BYTES =
  6 * (CHAT_MAX_PREPARED_PROMPT_CHARS + NATIVE_AUXILIARY_TEXT_BYTES) +
  4 * Math.ceil(CHAT_MAX_ATTACHMENT_BYTES / 3) +
  MiB;

export function base64DecodedBytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}
export function chatAttachmentBytes(images: readonly { data: string }[]): number {
  return images.reduce((total, image) => total + base64DecodedBytes(image.data), 0);
}
export const ChatMessageTextSchema = z
  .string()
  .max(CHAT_MAX_TEXT_BYTES)
  .refine(
    (text) => new TextEncoder().encode(text).byteLength <= CHAT_MAX_TEXT_BYTES,
    'Message exceeds 8 MiB of text',
  );
export const ChatImageSchema = z.strictObject({
  data: z
    .string()
    .min(1)
    .max(CHAT_MAX_IMAGE_BASE64_CHARS)
    .refine((data) => {
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      if (data.endsWith('==') && (alphabet.indexOf(data.at(-3)!) & 15) !== 0) return false;
      if (data.endsWith('=') && !data.endsWith('==') && (alphabet.indexOf(data.at(-2)!) & 3) !== 0)
        return false;
      return base64DecodedBytes(data) <= CHAT_MAX_IMAGE_BYTES;
    }, 'Invalid canonical base64 or image exceeds 10 MiB'),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
});
export const ChatImagesSchema = z
  .array(ChatImageSchema)
  .max(CHAT_MAX_IMAGES)
  .refine(
    (images) => chatAttachmentBytes(images) <= CHAT_MAX_ATTACHMENT_BYTES,
    'Attachments exceed 64 MiB combined',
  );
