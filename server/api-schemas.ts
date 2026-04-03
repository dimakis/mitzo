import { z } from 'zod';

export const LoginBody = z.object({
  passphrase: z.string().min(1),
});

export const FileWriteBody = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const PermissionDecision = z.enum(['once', 'always', 'deny']);
