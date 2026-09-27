import { type AuthSession, registerAuthSession } from './auth.js';
import { credentials, type CredentialResolver } from './credentials.js';
import {
  PublicationCredentialCustodian,
  type PublicationCommandRunner,
} from './symposium-publication-credentials.js';
import { SealedPublicationAuthority } from './symposium-sealed-publication-authority.js';
import {
  SealedPublicationService,
  type SealedPublicationArtifactTransport,
} from './symposium-sealed-publication-service.js';
import type { CapabilityOperationStore } from './connections/capabilities/operation-store.js';
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
/** Server-owned installation. Constructor registers references only; resolution
 * happens only after explicit authenticated selection. */
export class PublicationRegistration {
  readonly custodian: PublicationCredentialCustodian;
  readonly authority: SealedPublicationAuthority;
  readonly service: SealedPublicationService;
  readonly artifact: SealedPublicationArtifactTransport;
  readonly describeArtifact?: (
    sessionId: string,
    recordId: string,
    signal: AbortSignal,
  ) => Promise<{
    recordId: string;
    recordHash: string;
    sealId: string;
    sealHash: string;
    commit: string;
  }>;
  private stopped = false;
  private closed = false;
  private readonly operators = new Map<
    string,
    { expiresAt: number; controller: AbortController; unregister: () => void }
  >();
  constructor(options: {
    describeArtifact?: PublicationRegistration['describeArtifact'];
    authorityPath: string;
    operations: CapabilityOperationStore;
    credentials: readonly PublicationCredentialRegistration[];
    artifact: SealedPublicationArtifactTransport;
    resolver?: CredentialResolver;
    runner?: PublicationCommandRunner;
  }) {
    this.artifact = options.artifact;
    this.describeArtifact = options.describeArtifact;
    this.custodian = new PublicationCredentialCustodian(
      options.resolver ?? credentials,
      options.runner,
    );
    for (const source of options.credentials) {
      const value = PublicationCredentialRegistrationSchema.parse(source);
      this.custodian.register(value.id, value.label, value.reference);
    }
    this.authority = new SealedPublicationAuthority(options.authorityPath, {
      assertOperator: (id) => {
        const value = this.operators.get(id);
        if (!value || value.controller.signal.aborted || value.expiresAt <= Date.now())
          throw new Error('Authenticated publication operator required');
        return true;
      },
      assertArtifact: async (scope, signal) => {
        await this.artifact.require(scope, signal);
      },
      resolveCredential: (scope) =>
        this.custodian.resolve(
          scope.connectionId,
          scope.connectionRevision,
          scope.credentialGeneration,
        ),
    });
    this.service = new SealedPublicationService({
      authority: this.authority,
      operations: options.operations,
      artifact: this.artifact,
      credentialCustodianRegistered: options.credentials.length > 0,
    });
  }
  authorize(session: AuthSession): AbortSignal {
    if (this.stopped) throw new Error('Publication is shutting down');
    const prior = this.operators.get(session.id);
    if (prior && prior.expiresAt === session.expiresAt && !prior.controller.signal.aborted)
      return prior.controller.signal;
    this.invalidate(session.id);
    const controller = new AbortController();
    const value = { expiresAt: session.expiresAt, controller, unregister: () => {} };
    this.operators.set(session.id, value);
    value.unregister = registerAuthSession(session, () => this.invalidate(session.id));
    return controller.signal;
  }
  invalidate(id: string) {
    const value = this.operators.get(id);
    if (!value) return;
    this.operators.delete(id);
    value.controller.abort();
    value.unregister();
  }
  shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    for (const id of this.operators.keys()) this.invalidate(id);
    for (const credential of this.custodian.list())
      this.custodian.disconnect(credential.id, credential.revision);
  }
  close() {
    if (this.closed) return;
    this.shutdown();
    this.closed = true;
    this.authority.close();
  }
}
