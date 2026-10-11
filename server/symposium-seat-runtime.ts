import { createHash } from 'node:crypto';
import type { CodexAccountProfile } from './codex-account.js';
import { resolveSymposiumSubscriptionRoute } from './symposium-subscription-native.js';
import type { SeatConfig } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import {
  assertSymposiumSeatDispatchCurrent,
  type SymposiumDispatchFacts,
  type SymposiumHostGrantVerifier,
} from './symposium-dispatch-boundary.js';

/** Capability roles describe enforcement, not the custom agent's guidance or label. */
export function supportsSymposiumSeatCapability(
  seat: SeatConfig,
  allowed: ReadonlySet<'implementer' | 'coder' | 'reviewer'>,
): boolean {
  if (!seat.authorityRequest) return allowed.has(seat.role as 'implementer' | 'coder' | 'reviewer');
  if (
    !seat.authorityGrant ||
    seat.authorityGrant.filesystem === 'none' ||
    seat.authorityGrant.tools === 'none'
  )
    return false;
  return seat.authorityGrant.filesystem === 'write' && seat.authorityGrant.tools === 'write'
    ? allowed.has('implementer') || allowed.has('coder')
    : allowed.has('reviewer');
}

export type SymposiumSeatRoute =
  | {
      kind: 'chatgpt-subscription-native';
      accountId: string;
      provider: string;
      providerId: string;
      profile: CodexAccountProfile;
      model: string;
      effort: string | null;
      readOnly: boolean;
    }
  | {
      kind: 'openai-api';
      provider: string;
      providerId: string;
      model: string;
      effort: string | null;
      readOnly: boolean;
    }
  | {
      kind: 'claude-vertex';
      provider: string;
      providerId: string;
      model: string;
      effort: string | null;
      projectId: string;
      region: string;
      readOnly: boolean;
    };

/** A restored seat never resumes its predecessor's provider thread. */
export function symposiumSeatRuntimeId(input: SymposiumSeatExecution): string {
  const generation = input.provenance.membershipGeneration;
  if (generation === undefined)
    throw new Error('Native Symposium execution requires membership generation');
  const key = JSON.stringify([
    input.sessionId,
    input.seat.id,
    generation,
    input.seat.accountBinding,
    input.seat.reasoningEffort ?? null,
    input.seat.profileBinding,
    input.seat.contextGrant,
    input.seat.authorityGrant,
    input.seat.isolationRequest,
    ...('version' in input.provenance && input.provenance.version === 3
      ? [input.provenance.artifact]
      : []),
  ]);
  return `symposium:${createHash('sha256').update(key).digest('hex')}`;
}

/** Synchronous final fence: call immediately before the native provider operation. */
export function admitSymposiumSeatDispatch(
  facts: SymposiumDispatchFacts,
  profiles: AccountProfiles,
  input: SymposiumSeatExecution,
  hostGrants: SymposiumHostGrantVerifier,
): SymposiumSeatRoute {
  const seat = assertSymposiumSeatDispatchCurrent(facts, input, hostGrants);
  // The shared fence guarantees these bindings; native routing remains independently verified.
  if (!seat.accountBinding || !seat.authorityGrant) throw new Error('Seat binding unavailable');
  profiles.resume(seat.accountBinding);
  profiles.validateModelSelection(
    seat.accountBinding,
    seat.accountBinding.model,
    seat.reasoningEffort,
  );
  if (seat.authorityGrant.filesystem === 'none' || seat.authorityGrant.tools === 'none')
    throw new Error('Native seat route cannot enforce a no-tool authority grant');
  const readOnly =
    (!seat.authorityRequest && seat.role === 'reviewer') ||
    seat.authorityGrant.filesystem !== 'write' ||
    seat.authorityGrant.tools !== 'write';
  const common = {
    model: seat.accountBinding.model,
    effort: seat.reasoningEffort ?? null,
    readOnly,
  };
  if (seat.accountBinding.provider === 'openai-codex')
    return { ...resolveSymposiumSubscriptionRoute(profiles, seat.accountBinding), ...common };
  if (seat.accountBinding.provider === 'openai') {
    const profile = profiles.apiProfile(seat.accountBinding);
    if (!profile.sandboxProvider || !profile.sandboxProviderId)
      throw new Error('OpenAI seat lacks a pinned OpenShell account provider');
    return {
      kind: 'openai-api',
      provider: profile.sandboxProvider,
      providerId: profile.sandboxProviderId,
      ...common,
    };
  }
  if (seat.accountBinding.provider === 'anthropic-vertex') {
    const route = profiles.vertexSandboxRoute(seat.accountBinding);
    return { kind: 'claude-vertex', ...route, ...common };
  }
  throw new Error('Symposium native route does not support this account provider');
}
