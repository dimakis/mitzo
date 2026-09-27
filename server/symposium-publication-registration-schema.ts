import { z } from 'zod';
import { CredentialReferenceSchema } from './credentials.js';
export const PublicationCredentialRegistrationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  label: z.string().min(1).max(200),
  reference: CredentialReferenceSchema,
});
export type PublicationCredentialRegistration = z.infer<
  typeof PublicationCredentialRegistrationSchema
>;
