import { z } from 'zod';
import { CodexNativeTurnTargetSchema } from './codex-conversation-store.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.strictObject({ dev: z.number().int(), ino: z.number().int() });
const File = z.strictObject({ path: z.string().startsWith('/'), identity: Identity });
export const MaintenanceProcessIdentity = z.strictObject({
  pid: z.number().int().positive(),
  birth: z.string().min(1),
});
export const MaintenanceSeal = z.strictObject({
  planSha256: Hash,
  helpers: z.array(MaintenanceProcessIdentity),
  completionSha256: Hash,
});
export const MaintenanceRequirement = z.strictObject({
  version: z.literal(1),
  planFile: z.string().startsWith('/'),
  planSha256: Hash,
  sealSha256: Hash,
});
const Owner = z.strictObject({
  sessionId: z.string().min(1),
  authoritySha256: Hash,
  custodySha256: Hash,
  target: CodexNativeTurnTargetSchema.optional(),
});
export const MaintenancePlan = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  authorityId: z.string().uuid(),
  sourceOperationId: z.string().uuid(),
  sourceOperationSha256: Hash,
  sourceCommit: z.literal('279e6703dedebaeb130993fd6e2657b2aed73c0a'),
  targetCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourcePid: z.number().int().positive(),
  sourceGroup: z.number().int().positive(),
  sourceBirth: z.string().min(1),
  events: File,
  native: File,
  helpers: z.array(MaintenanceProcessIdentity),
  owners: z.array(Owner),
  expectedCommands: z.array(z.strictObject({ commandId: z.string(), sha256: Hash })),
});

/** Never print JSON parser snippets, secret capabilities, private rows or argv. */
export function maintenanceFailureDiagnostic(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return {
    ok: false,
    code: 'maintenance_unconfirmed',
    cause:
      error instanceof SyntaxError
        ? 'malformed_private_evidence'
        : typeof code === 'string' &&
            /^(?:SQLITE_[A-Z_]+|ENOENT|EACCES|EPERM|EEXIST|ELOOP)$/.test(code)
          ? code
          : 'operation_refused',
    message: 'Maintenance is unconfirmed; inspect retained private evidence before retrying',
  };
}
