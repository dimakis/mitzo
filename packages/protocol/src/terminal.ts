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
