import { z } from 'zod';
import { SymposiumConfigSchema } from './symposium.js';
/** Stable serialization for approved JSON payload identity, preserving array order. */
export function canonicalConfigurationOperationJson(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === 'object'
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)]),
          )
        : entry;
  return JSON.stringify(normalize(value));
}
export const SymposiumConfigurationOperationKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
export const SymposiumConfigurationOperationSchema = z
  .strictObject({
    version: z.literal(1),
    actor: z.string().min(1).max(256),
    idempotencyKey: SymposiumConfigurationOperationKeySchema,
    action: z.enum(['draft', 'config', 'seats/revise', 'activate']),
    expectedRevision: z.number().int().nonnegative(),
    request: z.record(z.string(), z.json()),
  })
  .refine(
    (value) =>
      value.request.idempotencyKey === value.idempotencyKey &&
      value.request.expectedRevision === value.expectedRevision &&
      new TextEncoder().encode(JSON.stringify(value.request)).byteLength <= 256 * 1024,
    'Configuration operation request identity differs',
  );
export type SymposiumConfigurationOperation = z.infer<typeof SymposiumConfigurationOperationSchema>;
export const SymposiumConfigurationOperationReceiptSchema =
  SymposiumConfigurationOperationSchema.safeExtend({
    sessionId: z.string().min(1).max(256),
    config: SymposiumConfigSchema,
    completedAt: z.number().int().nonnegative(),
  }).refine(
    (value) =>
      value.config.revision === value.expectedRevision + 1 &&
      (value.action !== 'draft' || value.config.state === 'draft') &&
      (!['activate', 'seats/revise'].includes(value.action) || value.config.state === 'active') &&
      (value.action === 'config' || value.config.version === 2) &&
      (value.action !== 'config' ||
        canonicalConfigurationOperationJson(value.config) ===
          canonicalConfigurationOperationJson(value.request.config)) &&
      (value.action !== 'seats/revise' ||
        value.config.seats.some((seat) => seat.id === value.request.seatId)),
    'Configuration result differs from original operation',
  );
export type SymposiumConfigurationOperationReceipt = z.infer<
  typeof SymposiumConfigurationOperationReceiptSchema
>;
