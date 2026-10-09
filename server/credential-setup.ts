import {
  ConnectionInputSchema,
  type CredentialConnectionInput,
} from './credential-connection-schema.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  requestTarget,
  type CredentialConnectionStore,
  type PublicCredentialConnection,
} from './credential-connections.js';

const custom = ConnectionInputSchema.pick({ auth: true, paths: true, methods: true })
  .extend({
    verificationPath: z.string().min(1).max(512),
    evidenceUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }),
  })
  .strict();
/** Agents provide configuration and documentation references, never credentials. */
export const PrepareConnectionSetupSchema = z
  .object({
    profile: z.enum(['home-assistant', 'custom']),
    endpoint: ConnectionInputSchema.shape.endpoint,
    label: ConnectionInputSchema.shape.label.optional(),
    access: z.enum(['read', 'read-write']).default('read'),
    allowPrivateNetwork: z.boolean().default(false),
    custom: custom.optional(),
  })
  .strict()
  .refine(
    (value) => (value.profile === 'custom' ? !!value.custom : !value.custom),
    'Custom services need documented authentication; known profiles configure it automatically',
  );

export interface ConnectionSetup {
  id: string;
  sessionId: string;
  revision: number;
  status: 'pending' | 'verifying' | 'ready' | 'cancelled' | 'expired';
  profile: 'home-assistant' | 'custom';
  expiresAt: number;
  connection: CredentialConnectionInput;
  credential: { label: string; instructions: string; helpUrl?: string };
  setupUrl: string;
  verificationPath: string;
  connectionId?: string;
  connectionRevision?: number;
  error?: string;
  delivery?: 'pending' | 'delivered';
}
type CreateVerified = (
  input: CredentialConnectionInput,
  secret: string,
  path: string,
  proof: (body: string) => boolean,
  signal: AbortSignal,
  stillAllowed: () => boolean,
) => Promise<PublicCredentialConnection>;
const retryMessage =
  'Could not verify this key. Check the key, service address and access, then try again.';

/** Secret-free persistent setup; browser submission is the sole credential boundary. */
export class CredentialConnectionSetups {
  private active = new Set<string>();
  constructor(
    private store: CredentialConnectionStore,
    private createVerified: CreateVerified,
    private discardVerified: (id: string, revision: number) => Promise<void>,
  ) {}
  prepare(sessionId: string, input: unknown): ConnectionSetup {
    if (!sessionId || sessionId.length > 256) throw new Error('Session unavailable');
    const parsed = PrepareConnectionSetupSchema.parse(input);
    const home = parsed.profile === 'home-assistant';
    const config = ConnectionInputSchema.parse({
      label: parsed.label ?? (home ? 'Home Assistant' : new URL(parsed.endpoint).hostname),
      endpoint: parsed.endpoint,
      serviceTemplate: home ? 'home-assistant' : 'custom',
      auth: home ? { kind: 'bearer' } : parsed.custom!.auth,
      paths: home ? ['/api/'] : parsed.custom!.paths,
      methods: home
        ? parsed.access === 'read'
          ? ['GET', 'HEAD']
          : ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
        : parsed.custom!.methods,
      allowPrivateNetwork: parsed.allowPrivateNetwork,
      homeAssistantDashboards: home ? parsed.access : 'disabled',
      websocket:
        home && parsed.access === 'read-write'
          ? {
              path: '/api/websocket',
              authentication: {
                kind: 'json',
                message: '{"type":"auth"}',
                credentialField: 'access_token',
                challenge: { field: 'type', equals: 'auth_required' },
                success: { field: 'type', equals: 'auth_ok' },
              },
            }
          : null,
    });
    if (
      parsed.access === 'read' &&
      config.methods.some((method) => !['GET', 'HEAD'].includes(method))
    )
      throw new Error('Read access cannot include write methods');
    if (!config.methods.includes('GET')) throw new Error('Verification requires GET access');
    const verificationPath = home ? '/api/' : parsed.custom!.verificationPath;
    requestTarget(config, verificationPath);
    const id = randomUUID();
    const setup: ConnectionSetup = {
      id,
      sessionId,
      revision: 1,
      status: 'pending',
      profile: parsed.profile,
      expiresAt: Date.now() + 30 * 60_000,
      connection: config,
      verificationPath,
      credential: home
        ? {
            label: 'Home Assistant key',
            instructions:
              'In Home Assistant, open your profile → Security → Long-lived access tokens. Create a token and paste it here. It stays out of chat.',
            helpUrl: 'https://www.home-assistant.io/docs/authentication/',
          }
        : {
            label:
              config.auth.kind === 'basic' || config.auth.kind === 'password'
                ? 'Password'
                : 'API key',
            instructions: 'Paste the credential for this service here. It stays out of chat.',
            helpUrl: parsed.custom!.evidenceUrl,
          },
      setupUrl: `/connections/setup/${id}`,
    };
    this.store.putSetup(setup);
    return setup;
  }
  status(sessionId: string, id: string) {
    const setup = this.store.getSetup(id);
    if (!setup || setup.sessionId !== sessionId) throw new Error('Setup unavailable');
    return this.browserStatus(id);
  }
  browserStatus(id: string): ConnectionSetup {
    const setup = this.store.getSetup(id);
    if (!setup) throw new Error('Setup unavailable');
    if (['pending', 'verifying'].includes(setup.status) && setup.expiresAt <= Date.now()) {
      const expired = { ...setup, status: 'expired' as const, revision: setup.revision + 1 };
      this.store.putSetup(expired);
      return expired;
    }
    // A process restart cannot resume credential work: ask for the key again.
    if (setup.status === 'verifying' && !this.active.has(id)) {
      const retry = {
        ...setup,
        status: 'pending' as const,
        revision: setup.revision + 1,
        error: retryMessage,
      };
      this.store.putSetup(retry);
      return retry;
    }
    return setup;
  }
  cancel(id: string, revision: number) {
    const setup = this.browserStatus(id);
    if (setup.revision !== revision || setup.status === 'verifying')
      throw new Error('Setup changed');
    if (setup.status !== 'pending') throw new Error('Setup unavailable');
    const next = { ...setup, status: 'cancelled' as const, revision: revision + 1 };
    if (!this.store.replaceSetupAtRevision(next, revision)) throw new Error('Setup changed');
    return next;
  }
  async complete(
    id: string,
    revision: number,
    secret: string,
    signal: AbortSignal,
    stillAllowed: () => boolean = () => true,
  ): Promise<ConnectionSetup> {
    const setup = this.browserStatus(id);
    if (setup.revision !== revision || setup.status === 'verifying')
      throw new Error('Setup changed');
    if (setup.status === 'ready') return setup;
    if (setup.status !== 'pending') throw new Error('Setup unavailable');
    if (!secret || secret.length > 16_384 || /[\r\n]/.test(secret))
      throw new Error('Invalid credential');
    const verifying = { ...setup, status: 'verifying' as const, revision: revision + 1 };
    if (!this.store.replaceSetupAtRevision(verifying, revision)) throw new Error('Setup changed');
    this.active.add(id);
    const allowed = () => {
      const current = this.store.getSetup(id);
      return (
        stillAllowed() &&
        !!current &&
        current.status === 'verifying' &&
        current.revision === verifying.revision &&
        current.expiresAt > Date.now()
      );
    };
    try {
      const proof =
        setup.profile === 'home-assistant'
          ? (body: string) => {
              try {
                return JSON.parse(body)?.message === 'API running.';
              } catch {
                return false;
              }
            }
          : () => true;
      const connection = await this.createVerified(
        setup.connection,
        secret,
        setup.verificationPath,
        proof,
        signal,
        allowed,
      );
      const ready: ConnectionSetup = {
        ...verifying,
        status: 'ready',
        revision: verifying.revision + 1,
        connectionId: connection.id,
        connectionRevision: connection.revision,
        delivery: 'pending',
      };
      delete ready.error;
      if (!this.store.replaceSetupAtRevision(ready, verifying.revision)) {
        await this.discardVerified(connection.id, connection.revision);
        throw new Error('Setup changed');
      }
      return ready;
    } catch {
      const retry: ConnectionSetup = {
        ...verifying,
        status: setup.expiresAt <= Date.now() ? 'expired' : 'pending',
        revision: verifying.revision + 1,
        error: retryMessage,
      };
      this.store.replaceSetupAtRevision(retry, verifying.revision);
      return this.store.getSetup(id)!;
    } finally {
      this.active.delete(id);
    }
  }
  pendingReady() {
    return this.store
      .listSetups()
      .filter((setup) => setup.status === 'ready' && setup.delivery !== 'delivered');
  }
  markDelivered(id: string) {
    const setup = this.store.getSetup(id);
    if (setup?.status === 'ready') this.store.putSetup({ ...setup, delivery: 'delivered' });
  }
}
