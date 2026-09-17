import type { JsonSchema } from '../types.js';

/** Exact, intentionally small JSON-schema subset used by reviewed templates. */
export function validateCapabilityInput(
  schema: JsonSchema,
  value: unknown,
): Readonly<Record<string, string | boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid capability input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Invalid capability input');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !Object.hasOwn(schema.properties, key)))
    throw new Error('Invalid capability input');
  if (schema.required.some((key) => !Object.hasOwn(input, key)))
    throw new Error('Invalid capability input');
  const out = Object.create(null) as Record<string, string | boolean>;
  for (const [key, definition] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(input, key)) continue;
    const item = input[key];
    if (definition.type === 'string') {
      if (
        typeof item !== 'string' ||
        item.length > (definition.maxLength ?? 65_536) ||
        item.includes('\u0000')
      )
        throw new Error('Invalid capability input');
      out[key] = item;
    } else {
      if (typeof item !== 'boolean') throw new Error('Invalid capability input');
      out[key] = item;
    }
  }
  return Object.freeze(out);
}

/** Canonical serialization makes the input hash independent of key order. */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
