import { z } from 'zod';

type Schema = {
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};

/** Report code-owned fields and constraints, never submitted values or Zod messages. */
export function toolInputError(label: string, schema: z.ZodType, error: z.ZodError) {
  const definition = z.toJSONSchema(schema) as Schema;
  const issues = error.issues.slice(0, 8).map((issue) => {
    let field = '';
    let node: Schema | undefined = definition;
    for (const part of issue.path) {
      if (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && node?.items) {
        node = node.items;
        field += `[${part}]`;
      } else if (
        typeof part === 'string' &&
        node?.properties &&
        Object.hasOwn(node.properties, part)
      ) {
        node = node.properties[part];
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
      case 'unrecognized_keys':
        constraint = 'Unknown fields are not allowed; use only fields in the tool schema';
        break;
      default:
        constraint = 'must satisfy the documented field constraints';
    }
    return `${field || 'input'}: ${constraint}.`;
  });
  return {
    content: `Invalid ${label}. ${issues.join(' ')} ${definition.description ?? ''} Correct the fields and retry; this request was not executed.`,
    isError: true,
  };
}
