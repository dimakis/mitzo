import { z } from 'zod';

/** Native wire shape shared by live approval attribution and retained recovery. */
export const CodexNativeFileChange = z.object({
  path: z.string().min(1),
  kind: z.discriminatedUnion('type', [
    z.object({ type: z.literal('add') }).strict(),
    z.object({ type: z.literal('delete') }).strict(),
    z.object({ type: z.literal('update'), move_path: z.string().min(1).nullable() }).strict(),
  ]),
  diff: z.string(),
});
