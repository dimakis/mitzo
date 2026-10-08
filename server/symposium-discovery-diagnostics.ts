import { CodexRequestError, CodexTransportError } from './codex-app-server-client.js';
import { nativeFailureCategories } from './codex-native-diagnostics.js';
import { SubscriptionRoutingIdentityError } from './symposium-subscription-identity.js';
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
    nativeFailure: z.enum(nativeFailureCategories).optional(),
    rpcCode: z.number().int().min(-2147483648).max(2147483647).optional(),
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
export class DiscoveryNativeMetadataFailure extends Error {
  constructor(readonly category: 'account_schema' | 'account_authentication') {
    super(
      category === 'account_authentication'
        ? 'Native discovery account is not authenticated'
        : 'Native discovery account metadata is unavailable',
    );
    this.name = 'DiscoveryNativeMetadataFailure';
  }
}
/** Only typed, bounded failures are projected. Generic Error text is never inspected. */
export function classifyDiscoveryFailure(
  error: unknown,
): Pick<
  DiscoveryDiagnostic,
  'failureClass' | 'commandDispatch' | 'exitCode' | 'nativeFailure' | 'rpcCode'
> {
  if (error instanceof DiscoveryCommandFailure) return error.detail;
  const base = {
    failureClass: 'operation-failed' as const,
    commandDispatch: 'not-observed' as const,
  };
  if (error instanceof CodexRequestError) {
    const nativeFailure = z.enum(nativeFailureCategories).safeParse(error.category);
    const rpcCode = DiscoveryDiagnosticSchema.shape.rpcCode.safeParse(error.code);
    return {
      ...base,
      nativeFailure: nativeFailure.success ? nativeFailure.data : 'unknown',
      ...(rpcCode.success && rpcCode.data !== undefined ? { rpcCode: rpcCode.data } : {}),
    };
  }
  if (error instanceof CodexTransportError)
    return {
      ...base,
      nativeFailure:
        error.category === 'timeout'
          ? 'rpc_timeout'
          : error.category === 'connection'
            ? 'rpc_connection'
            : 'rpc_protocol',
    };
  if (
    error instanceof SubscriptionRoutingIdentityError ||
    error instanceof DiscoveryNativeMetadataFailure
  )
    return { ...base, nativeFailure: error.category };
  return base;
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
