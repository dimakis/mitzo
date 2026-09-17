import type { JsonSchema } from '../types.js';

/** The shared permission handler suppresses payloads at 10,000 characters. */
export const MAX_CAPABILITY_APPROVAL_PAYLOAD_CHARS = 9_000;
/** Leaves room for capability identity, connection, operation, and digest. */
export const MAX_CAPABILITY_APPROVAL_INPUT_CHARS = 8_000;

/**
 * Upper bound for a JSON representation of a complete capability input.
 * Property names are registry-validated identifiers. A string character can
 * take up to six JSON characters (for example a control character), so this
 * is deliberately conservative.
 */
export function maxCompleteApprovalInputChars(schema: JsonSchema): number {
  const properties = Object.entries(schema.properties);
  return (
    2 +
    properties.reduce((total, [name, property], index) => {
      const valueChars = property.type === 'boolean' ? 5 : 2 + (property.maxLength ?? 65_536) * 6;
      return total + (index ? 1 : 0) + name.length + 3 + valueChars;
    }, 0)
  );
}

/**
 * A write is eligible only when its entire action input can be rendered in
 * the permission card. Hashes are binding evidence, never a substitute for
 * content the operator needs to evaluate.
 */
export function assertCompleteApprovalProjection(schema: JsonSchema): void {
  if (maxCompleteApprovalInputChars(schema) > MAX_CAPABILITY_APPROVAL_INPUT_CHARS)
    throw new Error('Capability input schema cannot fit a complete approval projection');
}
