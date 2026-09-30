import { z } from 'zod';
export const DiscoveryDiagnosticSchema = z
  .object({
    stage: z.enum([
      'preflight',
      'create',
      'readiness',
      'provider-verification',
      'native-initialize',
      'account-read',
      'model-list',
      'cleanup',
      'catalog-publication',
    ]),
    createDispatch: z.enum(['not-entered', 'possibly-dispatched']),
    failureClass: z.enum([
      'spawn-failed',
      'timeout',
      'nonzero-exit',
      'transport-or-process-failure',
      'invalid-response',
      'operation-failed',
    ]),
    commandDispatch: z.enum(['not-started', 'possibly-started', 'not-observed']),
    exitCode: z.number().int().min(0).max(255).optional(),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type DiscoveryDiagnostic = z.infer<typeof DiscoveryDiagnosticSchema>;
export class DiscoveryCommandFailure extends Error {
  constructor(
    readonly detail: Pick<DiscoveryDiagnostic, 'failureClass' | 'commandDispatch' | 'exitCode'>,
  ) {
    super('Discovery host operation failed');
  }
}
/** Diagnostic only: never changes allocation, cleanup, or admission authority. */
export function classifyDiscoveryCommandFailure(
  error: unknown,
  pid?: number,
): DiscoveryCommandFailure {
  const e =
    error && typeof error === 'object'
      ? (error as { code?: unknown; killed?: unknown; signal?: unknown })
      : {};
  if (!pid && (e.code === 'ENOENT' || e.code === 'EACCES'))
    return new DiscoveryCommandFailure({
      failureClass: 'spawn-failed',
      commandDispatch: 'not-started',
    });
  if (e.code === 'ETIMEDOUT' || (e.killed === true && e.signal === 'SIGTERM'))
    return new DiscoveryCommandFailure({
      failureClass: 'timeout',
      commandDispatch: 'possibly-started',
    });
  if (typeof e.code === 'number' && Number.isInteger(e.code) && e.code >= 0 && e.code <= 255)
    return new DiscoveryCommandFailure({
      failureClass: 'nonzero-exit',
      commandDispatch: 'possibly-started',
      exitCode: e.code,
    });
  return new DiscoveryCommandFailure({
    failureClass: 'transport-or-process-failure',
    commandDispatch: 'possibly-started',
  });
}
