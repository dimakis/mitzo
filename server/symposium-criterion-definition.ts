import { z } from 'zod';
import { canonicalReviewJson } from './symposium-review-records.js';
/** Pure definition validation only; no execution, review coordinator or receipt imports. */
const Id = z.string().trim().min(1);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const CheckPath = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine((value) => value.split('/').every((part) => !['.', '..', '.git'].includes(part)));
function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Buffer.byteLength(value) <= 4096;
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => boundedJson(item, depth + 1));
  if (
    typeof value !== 'object' ||
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, item]) =>
        !['__proto__', 'constructor', 'prototype'].includes(key) && boundedJson(item, depth + 1),
    )
  );
}
const JsonCaseValue = z.unknown().refine((value) => {
  if (!boundedJson(value)) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 4096;
}, 'Bounded finite JSON required');
export const SemanticCriterionDefinitionSchema = z
  .strictObject({
    id: Id.max(128),
    criterion: Id.max(2048),
    version: z.literal(1),
    kind: z.literal('python-json-cases'),
    path: CheckPath,
    cases: z
      .array(z.strictObject({ id: Id.max(128), input: JsonCaseValue, expected: JsonCaseValue }))
      .min(1)
      .max(8),
  })
  .refine(
    (value) => new Set(value.cases.map((c) => c.id)).size === value.cases.length,
    'Duplicate semantic case',
  )
  .refine((value) => {
    try {
      return Buffer.byteLength(canonicalReviewJson(value)) <= 65536;
    } catch {
      return false;
    }
  }, 'Semantic definition byte bound');
export const CriterionCheckDefinitionSchema = z.union([
  z.strictObject({
    id: Id,
    criterion: Id,
    version: z.literal(1),
    kind: z.literal('file-sha256'),
    path: CheckPath,
    expectedSha256: Sha,
  }),
  SemanticCriterionDefinitionSchema,
]);
export type SemanticCriterionDefinition = z.infer<typeof SemanticCriterionDefinitionSchema>;
export type CheckDefinition = z.infer<typeof CriterionCheckDefinitionSchema>;
