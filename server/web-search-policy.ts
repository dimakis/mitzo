import { createHash } from 'node:crypto';
import type { MitzoMode } from '@mitzo/protocol';

export type WebSearchAccess = 'disabled' | 'live';
export type WebSearchBackend = 'host' | 'openshell';
export type WebSearchGrant = 'unresolved' | 'denied' | 'allowed';

export interface PersistedWebSearchGrant {
  grant: WebSearchGrant;
  revision: number;
  updatedAt: number | null;
}

export interface WebSearchPolicyInput {
  backend: WebSearchBackend;
  deploymentCeiling: WebSearchAccess;
  deploymentRevision: string;
  mode: MitzoMode;
  modeCeilings?: Readonly<Record<MitzoMode, WebSearchAccess>>;
  conversationGrant: PersistedWebSearchGrant;
}

export type WebSearchPolicyReason =
  'deployment_ceiling' | 'mode_ceiling' | 'grant_unresolved' | 'grant_denied' | 'allowed';

export interface ResolvedWebSearchPolicy {
  backend: WebSearchBackend;
  effective: WebSearchAccess;
  reason: WebSearchPolicyReason;
  fingerprint: string;
  deploymentRevision: string;
  grantRevision: number;
}

export const DEFAULT_WEB_SEARCH_MODE_CEILINGS: Readonly<Record<MitzoMode, WebSearchAccess>> = {
  ask: 'disabled',
  agent: 'live',
  auto: 'live',
};

/** Every conversation requires an explicit web-search consent decision. */
export function initialWebSearchGrant(_mode: MitzoMode): WebSearchGrant {
  return 'unresolved';
}

export function resolveWebSearchPolicy(input: WebSearchPolicyInput): ResolvedWebSearchPolicy {
  const modeCeilings = input.modeCeilings ?? DEFAULT_WEB_SEARCH_MODE_CEILINGS;
  const modeCeiling = input.mode === 'ask' ? 'disabled' : modeCeilings[input.mode];
  let effective: WebSearchAccess = 'disabled';
  let reason: WebSearchPolicyReason;
  if (input.deploymentCeiling === 'disabled') reason = 'deployment_ceiling';
  else if (modeCeiling === 'disabled') reason = 'mode_ceiling';
  else if (input.conversationGrant.grant === 'unresolved') reason = 'grant_unresolved';
  else if (input.conversationGrant.grant === 'denied') reason = 'grant_denied';
  else {
    effective = 'live';
    reason = 'allowed';
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        backend: input.backend,
        deploymentCeiling: input.deploymentCeiling,
        deploymentRevision: input.deploymentRevision,
        mode: input.mode,
        modeCeilings: {
          ask: 'disabled',
          agent: modeCeilings.agent,
          auto: modeCeilings.auto,
        },
        grant: input.conversationGrant.grant,
        grantRevision: input.conversationGrant.revision,
        effective,
      }),
    )
    .digest('hex');
  return {
    backend: input.backend,
    effective,
    reason,
    fingerprint,
    deploymentRevision: input.deploymentRevision,
    grantRevision: input.conversationGrant.revision,
  };
}
