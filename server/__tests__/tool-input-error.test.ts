import { expect, it } from 'vitest';
import { z } from 'zod';
import { toolInputError } from '../tool-input-error.js';

it('returns field limits that let an agent correct a rejected publication', () => {
  const schema = z.object({ body: z.string().max(512), draft: z.boolean() }).strict();
  const parsed = schema.safeParse({ body: 'private draft'.repeat(80) });
  if (parsed.success) throw new Error('Expected invalid fixture');
  const result = toolInputError('GitHub publishing request', schema, parsed.error);
  expect(result.isError).toBe(true);
  expect(result.content).toContain('body');
  expect(result.content).toContain('512');
  expect(result.content).toContain('draft');
  expect(result.content).toContain('boolean');
  expect(result.content).not.toContain('private draft');
});

it('never reflects submitted values, unknown property names or custom validator messages', () => {
  const schema = z
    .object({ status: z.enum(['active', 'completed']) })
    .strict()
    .refine(() => false, 'private custom message');
  const parsed = schema.safeParse({ status: 'private status', 'private-key': 'private value' });
  if (parsed.success) throw new Error('Expected invalid fixture');
  const result = toolInputError('Telos item input', schema, parsed.error);
  expect(result.content).toContain('active');
  expect(result.content).toContain('completed');
  expect(result.content).toContain('Unknown fields');
  expect(result.content).not.toContain('private');
  const custom = schema.safeParse({ status: 'active' });
  if (custom.success) throw new Error('Expected refinement failure');
  expect(toolInputError('Telos item input', schema, custom.error).content).not.toContain('private');
});

it('identifies nested fields and array entries without echoing rejected text', () => {
  const schema = z.object({ links: z.array(z.object({ title: z.string().max(4) })) });
  const parsed = schema.safeParse({ links: [{ title: 'private title' }] });
  if (parsed.success) throw new Error('Expected invalid fixture');
  const result = toolInputError('Telos outcome input', schema, parsed.error);
  expect(result.content).toContain('links[0].title');
  expect(result.content).toContain('4');
  expect(result.content).not.toContain('private title');
});
