import { z } from 'zod';

export const TerminalOpenBody = z
  .object({ sessionId: z.string().min(1).max(200).optional() })
  .strict();
export const TerminalInputBody = z
  .object({
    data: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
export const TerminalResizeBody = z
  .object({
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  })
  .strict();
export const TerminalScrollBody = z
  .object({
    lines: z
      .number()
      .int()
      .min(-100)
      .max(100)
      .refine((value) => value !== 0)
      .nullable(),
  })
  .strict();
export interface TerminalInfo {
  id: string;
  kind: 'host' | 'sandbox';
  label: string;
  cwd: string;
  sessionId?: string;
  state: 'running' | 'ended' | 'unavailable';
  createdAt: number;
}
export type TerminalEvent =
  | { type: 'snapshot'; data: string; seq: number }
  | { type: 'output'; data: string; seq: number }
  | { type: 'exit'; seq: number }
  | { type: 'error'; error: string };

/** Command suggestions must stay visible and editable. Raw TTY input has a separate contract. */
export function isReviewableTerminalCommand(value: string): boolean {
  return (
    value.length <= 8192 &&
    !!value.trim() &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        (code >= 32 &&
          (code < 127 || code > 159) &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069) &&
          ![0x200b, 0x200e, 0x200f, 0xfeff].includes(code))
      );
    })
  );
}
