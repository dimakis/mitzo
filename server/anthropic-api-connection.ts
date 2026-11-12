import { z } from 'zod';
import {
  ApiHarnessConnectionSchema,
  PublicApiEndpointSchema,
  qualifiedApiCapabilities,
} from './account-harness-connection.js';

export const AnthropicApiConnectionSchema = ApiHarnessConnectionSchema.extend({
  endpoint: PublicApiEndpointSchema,
  protocol: z.literal('messages'),
  authentication: z.enum(['api-key', 'bearer']).default('api-key'),
}).superRefine((connection, context) => {
  try {
    qualifiedApiCapabilities(connection, 'Messages');
  } catch {
    context.addIssue({
      code: 'custom',
      message:
        'Confirm Messages streaming, tool calls, continuation and cancellation compatibility with the Claude engine',
    });
  }
});
export type AnthropicApiConnection = z.infer<typeof AnthropicApiConnectionSchema>;
