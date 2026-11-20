import { retainCallbackOutcome } from './turn-callbacks.js';
import { z } from 'zod';

type Schema = {
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};

/** Field names the schema declares anywhere. A union branch owns its fields at
 * the branch level, so walking a union's JSON schema loses them; only names
 * found here may be reported, and caller-invented keys still never appear. */
function declaredFields(schema: Schema | undefined, names = new Set<string>()): Set<string> {
  if (!schema) return names;
  for (const name of Object.keys(schema.properties ?? {})) {
    names.add(name);
    declaredFields(schema.properties![name], names);
  }
  declaredFields(schema.items, names);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])])
    declaredFields(branch, names);
  return names;
}

function schemaAt(schema: Schema | undefined, path: PropertyKey[]): Schema | undefined {
  let node = schema;
  for (const part of path) {
    if (!node) return undefined;
    node =
      typeof part === 'number'
        ? node.items
        : typeof part === 'string'
          ? node.properties?.[part]
          : undefined;
  }
  return node;
}

function unionBranches(schema: Schema | undefined): Schema[] | undefined {
  return schema ? (schema.anyOf ?? schema.oneOf ?? schema.allOf) : undefined;
}

type BranchFit = 'accepts' | 'rejects' | 'unknown';

/** Whether a union branch can describe the supplied input, judged only from the
 * literal values the branch pins for the fields it declares. A branch that pins
 * nothing inherits the answer from its own nested branches. */
function consistency(schema: Schema, supplied: Record<string, unknown>): BranchFit {
  const pins = Object.entries(schema.properties ?? {})
    .map(([field, node]): [string, unknown[]] | undefined => {
      const values = node.const !== undefined ? [node.const] : node.enum;
      return values ? [field, values] : undefined;
    })
    .filter((pin): pin is [string, unknown[]] => pin !== undefined);
  if (pins.length)
    return pins.some(
      ([field, values]) =>
        Object.hasOwn(supplied, field) &&
        !values.some((value) => Object.is(value, supplied[field])),
    )
      ? 'rejects'
      : 'accepts';
  const nested = unionBranches(schema);
  if (!nested?.length) return 'unknown';
  const branches: BranchFit[] = nested.map((branch) => consistency(branch, supplied));
  if (branches.every((branch) => branch === 'rejects')) return 'rejects';
  return branches.includes('accepts') ? 'accepts' : 'unknown';
}

/** Branch indexes that could have produced the caller's payload. Counting issues
 * alone would recommend changing a valid discriminator: the read form of
 * TelosManageTeam reports one error, so a link payload with missing fields used
 * to be answered with "operation: must be one of read". */
function consistentBranches(branches: Schema[] | undefined, input: unknown): number[] {
  if (!branches || !input || typeof input !== 'object') return [];
  const supplied = input as Record<string, unknown>;
  const judged = branches.map((branch, index) => ({
    index,
    state: consistency(branch, supplied),
  }));
  const accepting = judged.filter(({ state }) => state === 'accepts').map(({ index }) => index);
  if (accepting.length) return accepting;
  return judged.filter(({ state }) => state !== 'rejects').map(({ index }) => index);
}

/** Union failures carry their branches' issues. The closest branch names the
 * fields the caller actually got wrong; the top-level "must satisfy the
 * documented field constraints" would hide them behind an unusable message. */
function leafIssues(
  issues: z.core.$ZodIssue[],
  schema?: Schema,
  input?: unknown,
): z.core.$ZodIssue[] {
  const leaves = issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union') return [issue];
    const branchIssues = (issue as { errors?: z.core.$ZodIssue[][] }).errors ?? [];
    const branchSchemas = unionBranches(schemaAt(schema, issue.path));
    const branchLeaves = branchIssues
      .map((branch, index) => ({
        index,
        leaves: leafIssues(branch, branchSchemas?.[index], input),
      }))
      .filter((branch) => branch.leaves.length > 0);
    if (!branchLeaves.length) return [issue];
    const consistent =
      branchSchemas?.length === branchIssues.length
        ? new Set(consistentBranches(branchSchemas, input))
        : undefined;
    const candidates = branchLeaves.filter((branch) => consistent?.has(branch.index));
    return (candidates.length ? candidates : branchLeaves)
      .map((branch) => branch.leaves)
      .reduce((best, next) => (next.length < best.length ? next : best));
  });
  const seen = new Set<string>();
  return leaves.filter((issue) => {
    const key = `${issue.path.map(String).join('.')}|${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Report code-owned fields and constraints, never submitted values or Zod messages. */
export function formatToolInputError(
  label: string,
  schema: z.ZodType,
  error: z.ZodError,
  input?: unknown,
) {
  const definition = z.toJSONSchema(schema) as Schema;
  const declared = declaredFields(definition);
  const issues = leafIssues(error.issues, definition, input)
    .slice(0, 8)
    .map((issue) => {
      let field = '';
      let node: Schema | undefined = definition;
      for (const part of issue.path) {
        if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && node?.items) {
          node = node.items;
          field += `[${part}]`;
        } else if (
          typeof part === 'string' &&
          (node?.properties ? Object.hasOwn(node.properties, part) : declared.has(part))
        ) {
          node = node?.properties?.[part];
          field += `${field ? '.' : ''}${part}`;
        } else {
          field = '';
          break;
        }
      }
      let constraint: string;
      switch (issue.code) {
        case 'too_big':
        case 'too_small': {
          const limit = issue.code === 'too_big' ? issue.maximum : issue.minimum;
          const units =
            issue.origin === 'string' ? ' characters' : issue.origin === 'array' ? ' entries' : '';
          constraint = `must have ${issue.code === 'too_big' ? 'at most' : 'at least'} ${limit}${units}`;
          break;
        }
        case 'invalid_type':
          constraint = `must be ${issue.expected}`;
          break;
        case 'invalid_value':
          constraint = `must be one of ${issue.values.map(String).join(', ')}`;
          break;
        case 'invalid_format':
          constraint = `must be a valid ${issue.format}`;
          break;
        case 'unrecognized_keys':
          constraint = 'Unknown fields are not allowed; use only fields in the tool schema';
          break;
        default:
          constraint = 'must satisfy the documented field constraints';
      }
      return `${field || 'input'}: ${constraint}.`;
    });
  return [
    `Invalid ${label}.`,
    issues.join(' '),
    definition.description ?? '',
    'Correct the fields and retry; this request was not executed.',
  ]
    .filter(Boolean)
    .join(' ');
}

export function toolInputError(label: string, schema: z.ZodType, error: z.ZodError) {
  return retainCallbackOutcome(
    { content: formatToolInputError(label, schema, error), isError: true },
    'settled',
  );
}

/**
 * A rejected payload is the caller's argument mistake, never a permission
 * decision. Reporting it with a denial's text sent callers after an authority
 * regression that did not exist, so the SDK permission gates report the same
 * code-owned argument error the registered handler would.
 *
 * `undefined` means the input satisfied the schema.
 */
export function invalidToolArgumentsMessage(
  label: string,
  schema: z.ZodType,
  input: unknown,
): string | undefined {
  const parsed = schema.safeParse(input);
  if (parsed.success) return undefined;
  return formatToolInputError(`${label} arguments`, schema, parsed.error, input);
}
