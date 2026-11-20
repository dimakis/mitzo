import { retainCallbackOutcome } from './turn-callbacks.js';
import { z } from 'zod';

type Schema = {
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
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

/** Union failures carry their branches' issues. The closest branch names the
 * fields the caller actually got wrong; the top-level "must satisfy the
 * documented field constraints" would hide them behind an unusable message. */
function leafIssues(issues: z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  const leaves = issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union') return [issue];
    const branches = ((issue as { errors?: z.core.$ZodIssue[][] }).errors ?? [])
      .map(leafIssues)
      .filter((branch) => branch.length > 0);
    if (!branches.length) return [issue];
    return branches.reduce((best, next) => (next.length < best.length ? next : best));
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
export function formatToolInputError(label: string, schema: z.ZodType, error: z.ZodError) {
  const definition = z.toJSONSchema(schema) as Schema;
  const declared = declaredFields(definition);
  const issues = leafIssues(error.issues)
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
  return formatToolInputError(`${label} arguments`, schema, parsed.error);
}
