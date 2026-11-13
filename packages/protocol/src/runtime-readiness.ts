import { z } from 'zod';
import { AccountBindingSchema } from './account-binding.js';
import {
  SessionRuntimeBindingSchema,
  type SessionRuntimeBinding,
} from './session-runtime-binding.js';

function sameBinding(a: SessionRuntimeBinding, b: SessionRuntimeBinding): boolean {
  return (
    a.version === b.version &&
    a.account.accountId === b.account.accountId &&
    a.account.provider === b.account.provider &&
    a.account.profileRevision === b.account.profileRevision &&
    a.harness.implementation === b.harness.implementation &&
    a.execution.location === b.execution.location &&
    (a.version !== 2 ||
      (b.version === 2 &&
        a.execution.targetId === b.execution.targetId &&
        a.execution.targetRevision === b.execution.targetRevision))
  );
}

const reference = z.string().trim().min(1).max(200);
const timestamp = z.number().int().nonnegative();
const unknown = z.strictObject({
  state: z.literal('unknown'),
  reason: z.enum([
    'session_unavailable',
    'not_observed',
    'invalid_evidence',
    'scope_mismatch',
    'owner_unavailable',
  ]),
});
const unique = <T extends z.ZodType>(schema: T, key: (value: z.infer<T>) => string) =>
  z
    .array(schema)
    .max(256)
    .refine((items) => new Set(items.map(key)).size === items.length, {
      message: 'Ambiguous readiness evidence',
    });
const window = {
  observedAt: timestamp,
  expiresAt: timestamp,
};
const verification = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unknown') }),
  z
    .strictObject({ state: z.enum(['succeeded', 'failed', 'stale']), ...window })
    .refine((value) => value.expiresAt > value.observedAt, {
      message: 'Invalid evidence lifetime',
    }),
]);
const service = z.strictObject({
  id: reference,
  revision: reference,
  configured: z.enum(['yes', 'no', 'unknown']),
  approval: z.enum(['granted', 'denied', 'unknown']),
  attachment: z.enum(['attached', 'detached', 'unknown']),
  operations: unique(
    z.strictObject({
      operation: reference,
      policy: z.enum(['allowed', 'denied', 'unknown']),
      verification,
    }),
    (operation) => operation.operation,
  ),
});

/** Observations from an existing runtime owner, never a grant or admission token.
 * No raw errors, request bodies, environment variables or credential fields.
 * Approval, attachment, policy and an operation result are independent facts.
 */
export const RuntimeCapabilityObservationSchema = z
  .strictObject({
    scope: z.strictObject({
      sessionId: reference,
      accountId: reference,
      profileRevision: reference,
      model: reference,
      binding: SessionRuntimeBindingSchema,
      ownerRevision: reference,
    }),
    ...window,
    process: z.enum(['unknown', 'starting', 'ready', 'unavailable']),
    roots: z.strictObject({
      task: z.string().min(1).max(4096),
      knowledge: z.string().min(1).max(4096).nullable(),
    }),
    tools: unique(
      z.strictObject({ name: reference, state: z.enum(['available', 'unavailable', 'unknown']) }),
      (tool) => tool.name,
    ),
    executables: unique(
      z.strictObject({ command: reference, state: z.enum(['available', 'missing', 'unknown']) }),
      (executable) => executable.command,
    ),
    services: unique(service, (entry) => entry.id),
  })
  .superRefine((value, context) => {
    if (value.expiresAt <= value.observedAt)
      context.addIssue({ code: 'custom', message: 'Invalid evidence lifetime' });
  });

/** A partial snapshot by design. A selected model and configured runtime do not
 * prove a process is ready or a service operation works. Consumers must inspect
 * each state and retain original observation times. Unknown is not an empty grant.
 */
export const RuntimeReadinessSchema = z
  .strictObject({
    version: z.literal(1),
    sessionId: reference,
    observedAt: timestamp,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.discriminatedUnion('state', [
      unknown,
      z.strictObject({
        state: z.literal('observed'),
        account: AccountBindingSchema.omit({ model: true }),
        model: reference,
        mode: z.enum(['ask', 'agent', 'auto']),
        // Existing harness permission sets have no count or name-length limit.
        // Project their exact strings; observation limits must not hide Access.
        grants: z.array(z.string()),
        skillCeiling: z.array(z.string()).nullable(),
      }),
    ]),
    execution: z.discriminatedUnion('state', [
      unknown,
      z.strictObject({ state: z.literal('configured'), binding: SessionRuntimeBindingSchema }),
    ]),
    capabilities: z.discriminatedUnion('state', [
      unknown,
      z.strictObject({
        state: z.enum(['observed', 'stale']),
        evidence: RuntimeCapabilityObservationSchema,
      }),
    ]),
  })
  .superRefine((value, context) => {
    const { session, execution, capabilities } = value;
    const mismatch = (path: string[]) =>
      context.addIssue({ code: 'custom', path, message: 'Readiness evidence scope mismatch' });
    if (
      session.state === 'observed' &&
      execution.state === 'configured' &&
      (execution.binding.account.accountId !== session.account.accountId ||
        execution.binding.account.provider !== session.account.provider ||
        execution.binding.account.profileRevision !== session.account.profileRevision)
    )
      mismatch(['execution', 'binding']);
    if (capabilities.state === 'unknown') return;
    const { scope } = capabilities.evidence;
    if (
      session.state !== 'observed' ||
      execution.state !== 'configured' ||
      scope.sessionId !== value.sessionId ||
      scope.accountId !== session.account.accountId ||
      scope.profileRevision !== session.account.profileRevision ||
      scope.model !== session.model ||
      !sameBinding(scope.binding, execution.binding)
    )
      mismatch(['capabilities', 'evidence', 'scope']);
    // Compare to the snapshot's read time; client wall-clock skew grants nothing.
    if (
      capabilities.evidence.observedAt > value.observedAt ||
      capabilities.evidence.services.some((service) =>
        service.operations.some(
          (operation) =>
            operation.verification.state !== 'unknown' &&
            operation.verification.observedAt > value.observedAt,
        ),
      )
    )
      mismatch(['capabilities', 'evidence', 'observedAt']);
  });

export type RuntimeReadiness = z.infer<typeof RuntimeReadinessSchema>;
export type RuntimeCapabilityObservation = z.infer<typeof RuntimeCapabilityObservationSchema>;
