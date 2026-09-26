import { z } from 'zod';
import { SymposiumProfileDefinitionSchema } from '@mitzo/protocol';

// Portable guidance must not become a copy of a session, machine or credential.
const privateMaterial = [
  /\/(?:Users|home|sandbox|tmp|private\/tmp|private\/var\/folders)\//i,
  /[A-Za-z]:\\(?:Users|Temp)\\/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/i,
  /\b(?:Bearer\s+[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/i,
  /\b(?:api[_ -]?key|password|client[_ -]?secret)\s*[:=]/i,
  /\[(?:conversation|chat) transcript\]/i,
];

export const PortableProfileDefinitionSchema = SymposiumProfileDefinitionSchema.superRefine(
  (definition, ctx) => {
    const fields = [
      definition.name,
      definition.instructions,
      definition.expectedOutput,
      definition.modelPolicyRole,
      ...definition.acceptanceCriteria,
      ...(definition.recipe ? [JSON.stringify(definition.recipe)] : []),
    ];
    if (fields.join('\n').length > 6000)
      ctx.addIssue({ code: 'custom', message: 'Portable profile guidance is too long' });
    for (const field of fields) {
      if (privateMaterial.some((pattern) => pattern.test(field))) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Portable profiles cannot contain credentials, transcript dumps or machine paths',
        });
        break;
      }
    }
  },
);

export type PortableProfileDefinition = z.infer<typeof PortableProfileDefinitionSchema>;
