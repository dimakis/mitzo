import { createHash, randomUUID } from 'node:crypto';
import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import type { CapabilityApproval } from './types.js';
import { canonicalJson } from './input-validation.js';

export const EXECUTE_CAPABILITY_TOOL = 'ExecuteProviderCapability';

const PREVIEW_CHARS = 2_000;
const MAX_REVIEW_INPUT_CHARS = 7_000;
const FALLBACK_FIELD_LIMIT = 12;
const FALLBACK_FIELD_NAME_CHARS = 120;
const FALLBACK_VALUE_PREVIEW_CHARS = 300;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function reviewValue(value: string | boolean): string | boolean | Record<string, unknown> {
  if (typeof value !== 'string' || value.length <= PREVIEW_CHARS) return value;
  return {
    chars: value.length,
    sha256: digest(value),
    preview: value.slice(0, PREVIEW_CHARS),
    truncated: true,
  };
}

function reviewInput(input: Readonly<Record<string, string | boolean>>) {
  const reviewed = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, reviewValue(value)]),
  );
  // A template can contain more than the familiar GitHub fields.  Never let a
  // large-but-valid input make the permission card silently omit the request.
  // The fallback retains a digest of every byte plus a bounded, named sample
  // of what is being approved.
  if (JSON.stringify(reviewed).length <= MAX_REVIEW_INPUT_CHARS) return reviewed;
  const sampled = Object.entries(input)
    .slice(0, FALLBACK_FIELD_LIMIT)
    .map(([key, value]) => ({
      name: key.slice(0, FALLBACK_FIELD_NAME_CHARS),
      value:
        typeof value === 'string'
          ? {
              chars: value.length,
              sha256: digest(value),
              preview: value.slice(0, FALLBACK_VALUE_PREVIEW_CHARS),
              truncated: value.length > FALLBACK_VALUE_PREVIEW_CHARS,
            }
          : value,
    }));
  return {
    truncated: true,
    fieldCount: Object.keys(input).length,
    sampledFields: sampled,
    inputSha256: digest(canonicalJson(input)),
  };
}

export function capabilityApprovalPayload(request: Parameters<CapabilityApproval>[0]) {
  return {
    // This is a review representation, not the executor input. Long valid
    // bodies retain their length, digest, and bounded preview so approval is
    // meaningful without hitting the shared permission card's 10k limit.
    input: reviewInput(request.input),
    inputSha256: digest(canonicalJson(request.input)),
    capabilityId: request.capabilityId,
    capabilityVersion: request.capabilityVersion,
    connectionId: request.connectionId,
    operationId: request.operationId,
  };
}

/**
 * Capability mutations deliberately use Mitzo's existing permission queue. A
 * model, browser, or reconnect cannot convert a prior tool permission into a
 * grant: each operation passes forcePrompt and is tied to one conversation.
 */
export function capabilityApprovalForConversation(
  registry: SessionRegistry,
  conversationId: string,
): CapabilityApproval {
  return async (request, signal) => {
    const owner = registry.findBySessionId(conversationId);
    if (!owner) return false;
    const decision = await buildPermissionHandler(owner.clientId, registry)(
      EXECUTE_CAPABILITY_TOOL,
      capabilityApprovalPayload(request),
      {
        signal,
        toolUseID: randomUUID(),
        forcePrompt: request.forcePrompt,
        approvalScope: 'conversation',
        title: 'Approve provider capability?',
        description:
          'This performs the reviewed provider operation shown below. Mitzo will record the result and verify it before reporting success.',
      },
    );
    return decision.behavior === 'allow';
  };
}
