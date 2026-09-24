import { PERMISSION_INPUT_MAX_CHARS, serializePermissionDisplayInput } from '@mitzo/harness';
import type { JsonSchema } from '../types.js';

const MAX_CAPABILITY_APPROVAL_PROPERTIES = 64;
const CAPABILITY_ID_MAX_CHARS = 120;
const CAPABILITY_VERSION_MAX_DIGITS = 9;
const UUID_CHARS = 36;

/**
 * Upper bound for the exact permission-card rendering of a complete input.
 * Property names are registry-validated identifiers. A string character can
 * take up to six JSON characters (for example a control character), so this
 * is deliberately conservative.
 */
export function maxCompleteApprovalDisplayChars(schema: JsonSchema): number {
  const input = Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => [
      name,
      property.type === 'boolean' ? false : '\u0001'.repeat(property.maxLength ?? 65_536),
    ]),
  );
  // Use the harness serializer itself: its pretty printed whitespace and the
  // full outer envelope are part of the operator-visible approval contract.
  return (
    serializePermissionDisplayInput('ExecuteProviderCapability', {
      input,
      inputSha256: 'a'.repeat(64),
      capabilityId: 'a'.repeat(CAPABILITY_ID_MAX_CHARS),
      capabilityVersion: Number('9'.repeat(CAPABILITY_VERSION_MAX_DIGITS)),
      connectionId: 'a'.repeat(UUID_CHARS),
      operationId: 'a'.repeat(UUID_CHARS),
    })?.length ?? Infinity
  );
}

/**
 * A write is eligible only when its entire action input can be rendered in
 * the permission card. Hashes are binding evidence, never a substitute for
 * content the operator needs to evaluate.
 */
export function assertCompleteApprovalProjection(schema: JsonSchema): void {
  if (
    Object.keys(schema.properties).length > MAX_CAPABILITY_APPROVAL_PROPERTIES ||
    maxCompleteApprovalDisplayChars(schema) > PERMISSION_INPUT_MAX_CHARS
  )
    throw new Error('Capability input schema cannot fit a complete approval projection');
}
