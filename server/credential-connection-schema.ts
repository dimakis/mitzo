import { z } from 'zod';
import { WebSocketConfigSchema } from './credential-websocket.js';
import { DashboardAccessSchema } from './home-assistant-dashboard.js';
const header = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
  .refine(
    (name) =>
      ![
        'host',
        'cookie',
        'proxy-authorization',
        'content-length',
        'transfer-encoding',
        'connection',
        'content-type',
        'accept',
        'accept-encoding',
      ].includes(name.toLowerCase()),
    'Reserved authentication header',
  );
export const ConnectionAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bearer') }).strict(),
  z
    .object({
      kind: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^:\r\n]+$/),
    })
    .strict(),
  z.object({ kind: z.literal('api-key'), headerName: header }).strict(),
  z.object({ kind: z.literal('password'), headerName: header }).strict(),
]);
export const ConnectionInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    serviceTemplate: z.enum(['custom', 'home-assistant']).optional(),
    endpoint: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const u = new URL(value);
          return (
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            u.pathname === '/' &&
            !u.search &&
            !u.hash &&
            u.origin === value
          );
        } catch {
          return false;
        }
      }, 'Use an HTTPS origin without a path, username or password'),
    auth: ConnectionAuthSchema,
    paths: z
      .array(
        z
          .string()
          .max(512)
          .regex(/^\/[A-Za-z0-9_/-]*$/)
          .refine((p) => !p.includes('//')),
      )
      .min(1)
      .max(16),
    methods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1)
      .max(6),
    allowPrivateNetwork: z.boolean().default(false),
    homeAssistantDashboards: DashboardAccessSchema.default('disabled'),
    websocket: WebSocketConfigSchema.nullable().optional(),
  })
  .strict();
export type CredentialConnectionInput = z.infer<typeof ConnectionInputSchema>;
