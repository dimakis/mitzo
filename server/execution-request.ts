import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { V2SendMessage } from '@mitzo/protocol';

type SendMessage = z.infer<typeof V2SendMessage>;

const MAX_STRING_BYTES = 1_000_000;
const MAX_ARRAY_ITEMS = 1_024;
const MAX_CANONICAL_BYTES = 2_000_000;

export type ExecutionRequestInput = {
  operation: string;
  sessionId?: string | null;
  rawUserIntent: string;
  effectiveProviderPrompt: string;
  accountId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  mode?: string | null;
  cwd?: string | null;
  /** Set-like: duplicates and ordering do not affect tool authorization. */
  extraTools?: string[];
  /** Set-like: duplicates and ordering do not affect tool authorization. */
  allowedTools?: string[];
  isolation?: boolean | null;
  images?: Array<{ mediaType: string; data: string | Uint8Array }>;
  /** Ordered because prompt assembly preserves context-block order. */
  contextBlocks?: string[];
  telosTaskId?: string | null;
  agentName?: string | null;
  skill?: {
    name: string;
    renderedPrompt: string;
    /** Set-like, matching the execution allow-list semantics. */
    allowedTools?: string[];
  } | null;
};

/**
 * The canonical representation deliberately contains hashes rather than prompt,
 * image, or context contents. Object keys are recursively sorted; array order
 * is preserved except tool lists, which are normalized as set-like allow-lists.
 * Optional scalar fields are explicit null and optional arrays are explicit [].
 */
export type CanonicalExecutionRequest = {
  operation: string;
  sessionId: string | null;
  rawUserIntentHash: string;
  effectiveProviderPromptHash: string;
  accountId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  mode: string | null;
  cwd: string | null;
  extraTools: string[];
  allowedTools: string[];
  isolation: boolean | null;
  images: Array<{ mediaType: string; bytesHash: string }>;
  contextBlockHashes: string[];
  telosTaskId: string | null;
  agentName: string | null;
  skill: { name: string; renderedPromptHash: string; allowedTools: string[] } | null;
};

export function sha256Base64url(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

function boundedString(value: string, field: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
    throw new TypeError(`${field} exceeds ${MAX_STRING_BYTES} UTF-8 bytes`);
  }
  return value;
}

function boundedArray<T>(value: T[], field: string): T[] {
  if (value.length > MAX_ARRAY_ITEMS)
    throw new TypeError(`${field} exceeds ${MAX_ARRAY_ITEMS} items`);
  return value;
}

function nullableString(value: string | null | undefined, field: string): string | null {
  return value == null ? null : boundedString(value, field);
}

function normalizedToolSet(tools: string[] | undefined, field: string): string[] {
  return [
    ...new Set(boundedArray(tools ?? [], field).map((tool) => boundedString(tool, field))),
  ].sort();
}

function imageBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data !== 'string') return data;
  // V2 validation supplies base64 image data. Hash decoded bytes, never the text.
  return Buffer.from(data, 'base64');
}

export function canonicalizeExecutionRequest(
  input: ExecutionRequestInput,
): CanonicalExecutionRequest {
  const images = boundedArray(input.images ?? [], 'images').map((image) => ({
    mediaType: boundedString(image.mediaType, 'images.mediaType'),
    bytesHash: sha256Base64url(imageBytes(image.data)),
  }));
  const contextBlockHashes = boundedArray(input.contextBlocks ?? [], 'contextBlocks').map(
    (content) => sha256Base64url(boundedString(content, 'contextBlocks.content')),
  );
  const skill = input.skill
    ? {
        name: boundedString(input.skill.name, 'skill.name'),
        renderedPromptHash: sha256Base64url(
          boundedString(input.skill.renderedPrompt, 'skill.renderedPrompt'),
        ),
        allowedTools: normalizedToolSet(input.skill.allowedTools, 'skill.allowedTools'),
      }
    : null;
  return {
    operation: boundedString(input.operation, 'operation'),
    sessionId: nullableString(input.sessionId, 'sessionId'),
    rawUserIntentHash: sha256Base64url(boundedString(input.rawUserIntent, 'rawUserIntent')),
    effectiveProviderPromptHash: sha256Base64url(
      boundedString(input.effectiveProviderPrompt, 'effectiveProviderPrompt'),
    ),
    accountId: nullableString(input.accountId, 'accountId'),
    model: nullableString(input.model, 'model'),
    reasoningEffort: nullableString(input.reasoningEffort, 'reasoningEffort'),
    mode: nullableString(input.mode, 'mode'),
    cwd: nullableString(input.cwd, 'cwd'),
    extraTools: normalizedToolSet(input.extraTools, 'extraTools'),
    allowedTools: normalizedToolSet(input.allowedTools, 'allowedTools'),
    isolation: input.isolation ?? null,
    images,
    contextBlockHashes,
    telosTaskId: nullableString(input.telosTaskId, 'telosTaskId'),
    agentName: nullableString(input.agentName, 'agentName'),
    skill,
  };
}

/** Stable JSON serialization for JSON-only values; object keys sort recursively. */
export function stableSerializeJson(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (current: unknown): string => {
    if (current === null) return 'null';
    switch (typeof current) {
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current))
          throw new TypeError('Canonical JSON rejects non-finite numbers');
        return JSON.stringify(current);
      case 'string':
        return JSON.stringify(boundedString(current, 'canonical string'));
      case 'object': {
        if (ancestors.has(current)) throw new TypeError('Canonical JSON rejects circular values');
        ancestors.add(current);
        try {
          if (Array.isArray(current)) {
            return `[${boundedArray(current, 'canonical array').map(serialize).join(',')}]`;
          }
          const prototype = Object.getPrototypeOf(current);
          if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('Canonical JSON accepts only plain objects');
          }
          const object = current as Record<string, unknown>;
          return `{${Object.keys(object)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`)
            .join(',')}}`;
        } finally {
          ancestors.delete(current);
        }
      }
      default:
        throw new TypeError('Canonical JSON rejects non-JSON values');
    }
  };
  const canonical = serialize(value);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) {
    throw new TypeError(`Canonical request exceeds ${MAX_CANONICAL_BYTES} UTF-8 bytes`);
  }
  return canonical;
}

export function fingerprintExecutionRequest(input: ExecutionRequestInput): string {
  return sha256Base64url(stableSerializeJson(canonicalizeExecutionRequest(input)));
}

function splitExtraTools(extraTools: string | undefined): string[] {
  return extraTools
    ? extraTools
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean)
    : [];
}

/**
 * Slice 2's receipt boundary only has validated V2 fields. Later runtime
 * wiring supplies resolved context contents, rendered skill prompts, and the
 * final provider prompt through ExecutionRequestInput directly.
 */
export function executionRequestFromValidatedSend(message: SendMessage): ExecutionRequestInput {
  return {
    operation: message.type,
    sessionId: message.sessionId,
    rawUserIntent: message.prompt,
    effectiveProviderPrompt: message.prompt,
    accountId: message.accountId,
    model: message.model,
    reasoningEffort: message.reasoningEffort,
    mode: message.mode,
    cwd: message.cwd,
    extraTools: splitExtraTools(message.extraTools),
    allowedTools: [],
    isolation: message.isolation,
    images: message.images ?? [],
    // The receipt boundary has validated block selectors, not resolved file
    // contents. They are still hashed here; runtime wiring will pass content.
    contextBlocks: message.contextBlocks ?? [],
    telosTaskId: message.telosTaskId,
    agentName: message.agentName,
    skill: null,
  };
}
