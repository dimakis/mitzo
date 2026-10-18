import { isDeepStrictEqual } from 'node:util';

type Schema = Record<string, unknown>;
type Compiled = { schema: Schema; validate(value: unknown): void };
function invalid(): never {
  throw Error('Tool draft uses an unsupported or invalid bounded schema');
}
const object = (value: unknown): value is Schema =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const assertValue = (condition: boolean) => {
  if (!condition) throw Error('Tool draft example violates its declared schema');
};
function compile(raw: unknown, depth: number, budget: { nodes: number }): Compiled {
  if (!object(raw) || depth > 8 || ++budget.nodes > 100) invalid();
  const type = raw.type;
  if (
    typeof type !== 'string' ||
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)
  )
    invalid();
  const fields: Record<string, string[]> = {
    object: ['properties', 'required', 'additionalProperties'],
    array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength', 'enum'],
    number: ['minimum', 'maximum', 'enum'],
    integer: ['minimum', 'maximum', 'enum'],
    boolean: ['enum'],
    null: [],
  };
  if (
    Object.keys(raw).some(
      (key) => !['type', '$schema', 'description', 'title', ...fields[type]].includes(key),
    )
  )
    invalid();
  if (
    raw.$schema !== undefined &&
    ![
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
    ].includes(String(raw.$schema))
  )
    invalid();
  for (const key of ['description', 'title'])
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || String(raw[key]).length > 500))
      invalid();
  const bound = (key: string, fallback: number, cap: number) => {
    const value = raw[key] === undefined ? fallback : raw[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > cap)
      invalid();
    return value;
  };
  let compiled: Compiled;
  if (type === 'object') {
    if (
      !object(raw.properties) ||
      raw.additionalProperties !== false ||
      Object.keys(raw.properties).length > 50
    )
      invalid();
    const required = raw.required === undefined ? [] : raw.required;
    if (
      !Array.isArray(required) ||
      required.some(
        (key) => typeof key !== 'string' || !Object.hasOwn(raw.properties as Schema, key),
      ) ||
      new Set(required).size !== required.length
    )
      invalid();
    const properties = Object.fromEntries(
      Object.entries(raw.properties).map(([key, value]) => {
        if (key.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
        return [key, compile(value, depth + 1, budget)];
      }),
    );
    compiled = {
      schema: {
        type,
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [key, value.schema]),
        ),
        required: [...required].sort(),
        additionalProperties: false,
      },
      validate(value) {
        assertValue(object(value));
        const record = value as Schema;
        assertValue(
          Object.keys(record).every((key) => Object.hasOwn(properties, key)) &&
            required.every((key) => Object.hasOwn(record, key)),
        );
        for (const [key, item] of Object.entries(properties))
          if (Object.hasOwn(record, key)) item.validate(record[key]);
      },
    };
  } else if (type === 'array') {
    const items = compile(raw.items, depth + 1, budget);
    const minimum = bound('minItems', 0, 100),
      maximum = bound('maxItems', 100, 100);
    if (minimum > maximum) invalid();
    compiled = {
      schema: { type, items: items.schema, minItems: minimum, maxItems: maximum },
      validate(value) {
        assertValue(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
        for (const item of value as unknown[]) items.validate(item);
      },
    };
  } else if (type === 'string') {
    const minimum = bound('minLength', 0, 16384),
      maximum = bound('maxLength', 16384, 16384);
    if (minimum > maximum) invalid();
    compiled = {
      schema: { type, minLength: minimum, maxLength: maximum },
      validate(value) {
        assertValue(typeof value === 'string');
        const text = value as string;
        const length = [...text].length;
        assertValue(length >= minimum && length <= maximum && !text.includes('\0'));
      },
    };
  } else if (type === 'number' || type === 'integer') {
    const minimum = raw.minimum === undefined ? -Number.MAX_SAFE_INTEGER : raw.minimum,
      maximum = raw.maximum === undefined ? Number.MAX_SAFE_INTEGER : raw.maximum;
    if (
      typeof minimum !== 'number' ||
      typeof maximum !== 'number' ||
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) ||
      minimum > maximum
    )
      invalid();
    compiled = {
      schema: { type, minimum, maximum },
      validate(value) {
        assertValue(
          typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= minimum &&
            value <= maximum &&
            (type !== 'integer' || Number.isSafeInteger(value)),
        );
      },
    };
  } else
    compiled = {
      schema: { type },
      validate(value) {
        assertValue(type === 'null' ? value === null : typeof value === 'boolean');
      },
    };
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || !raw.enum.length || raw.enum.length > 20) invalid();
    for (const value of raw.enum) compiled.validate(value);
    const enumeration = raw.enum;
    const previous = compiled.validate;
    compiled = {
      schema: { ...compiled.schema, enum: enumeration },
      validate(value) {
        previous(value);
        assertValue(enumeration.some((item) => isDeepStrictEqual(item, value)));
      },
    };
  }
  return compiled;
}
/** Intentional JSON-schema subset: no references, patterns, code or unbounded traversal. */
export function compileToolBuilderSchema(raw: unknown): Compiled {
  if (!object(raw) || raw.type !== 'object') invalid();
  return compile(raw, 0, { nodes: 0 });
}
export function validateToolBuilderExamples(contract: {
  inputSchema: unknown;
  outputSchema: unknown;
  examples: readonly { input: unknown; expected: unknown }[];
}) {
  const input = compileToolBuilderSchema(contract.inputSchema),
    output = compileToolBuilderSchema(contract.outputSchema);
  for (const example of contract.examples) {
    input.validate(example.input);
    output.validate(example.expected);
  }
  return { input, output };
}
