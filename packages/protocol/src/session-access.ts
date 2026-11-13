import { z } from 'zod';
import type { AccountBinding } from './account-binding.js';
import type { RuntimeReadiness } from './runtime-readiness.js';
import type { SessionControlSupport } from './session-control-support.js';
import type { MitzoMode } from './types.js';

/** Catalog support only. It is neither an executable inventory nor a grant. */
export const SessionHelperSupportSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('unknown'),
    reason: z.enum(['runtime_unavailable', 'route_unqualified', 'selection_unavailable']),
  }),
  z.strictObject({
    state: z.literal('configured'),
    tools: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(256),
          source: z.string().min(1).max(256),
          requirement: z.string().max(4000),
          state: z.enum(['supported', 'unsupported', 'excluded', 'restricted']),
        }),
      )
      .max(1024)
      .refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length),
  }),
]);
export type SessionHelperSupport = z.infer<typeof SessionHelperSupportSchema>;

/** Bounded observation, never admission. Unknown is not an empty grant. */
export interface SessionAccessEvidence {
  sessionId: string;
  observedAt: number;
  state: 'current' | 'unknown';
  account: Pick<AccountBinding, 'accountId' | 'accountLabel' | 'provider'> | null;
  model: string | null;
  mode: MitzoMode | null;
  grants: string[] | null;
  skillCeiling: string[] | null;
  pending: Array<{ permId: string; toolName: string; scope: string }> | null;
  attachments: null;
  tools: null;
  limits: null;
  readiness: RuntimeReadiness;
  helperSupport: SessionHelperSupport;
  controls: SessionControlSupport;
}
