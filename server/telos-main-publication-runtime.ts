import { createLogger } from './logger.js';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import { credentials } from './credentials.js';
import { PublicationCredentialCustodian } from './symposium-publication-credentials.js';
import {
  GithubMainMergeSelection,
  GithubMainMergeRegistrationSchema,
  type GithubMainMergeRegistration,
} from './github-main-merge-selection.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { TelosItemStore } from './telos-item-store.js';
import { TelosSourceCapture } from './telos-source-capture.js';
import { TelosSourceApprovalStore } from './telos-source-approval-store.js';
import type { NativeMainPublicationCall } from './telos-main-publication-host.js';
import { createTelosMainPublicationHost } from './telos-main-publication-host.js';
import { TelosMainPublication } from './telos-main-publication.js';
import { RequestGithubMainPublicationSchema } from './telos-main-publication-contract.js';
import { TelosWorkStore } from './telos-work-store.js';
import {
  isAvailableTelosWorkConversation,
  isAvailableTelosSourceConversation,
} from './telos-work-conversation.js';

const configuration = z.strictObject({
  version: z.literal(1),
  registrations: z.array(GithubMainMergeRegistrationSchema).max(128),
});
const unavailable = () => Error('Configured native Telos publication unavailable');

/** Explicit server configuration; never read from tool intent or chat environment.
 * Reading this metadata does not resolve a credential or open the canonical DB. */
export function readTelosMainPublicationConfiguration(path: string) {
  if (!isAbsolute(path)) throw unavailable();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size > 1024n * 1024n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o022n) !== 0n
    )
      throw unavailable();
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd, { bigint: true });
    if (
      bytes.length > 1024 * 1024 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw unavailable();
    return configuration.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let active: TelosMainPublicationRuntime | undefined;
/** A registration lifetime, not a provider/session, approval or count owner. */
export class TelosMainPublicationRuntime {
  private readonly selection: GithubMainMergeSelection;
  private readonly retired = new AbortController();
  private readonly database: string;
  private readonly registry: SessionRegistry;
  private readonly events: EventStore;
  constructor(owners: {
    registry: SessionRegistry;
    events: EventStore;
    databasePath(): string;
    registrations: readonly GithubMainMergeRegistration[];
    custodian: PublicationCredentialCustodian;
  }) {
    this.database = owners.databasePath();
    if (!isAbsolute(this.database)) throw unavailable();
    this.registry = owners.registry;
    this.events = owners.events;
    this.selection = new GithubMainMergeSelection(owners);
  }
  supportsHost(registry: SessionRegistry, events: EventStore): boolean {
    return (
      active === this &&
      !this.retired.signal.aborted &&
      registry === this.registry &&
      events === this.events
    );
  }
  supports(registry: SessionRegistry, events: EventStore, accountId: string): boolean {
    return this.supportsHost(registry, events) && this.selection.supportsAccount(accountId);
  }
  close(): void {
    this.retired.abort(unavailable());
    if (active === this) active = undefined;
    this.selection.close();
  }
  bindContext<T extends NativeMainPublicationCall>(context: T): T {
    const assertCurrentSync = () => {
      if (active !== this) throw unavailable();
      this.retired.signal.throwIfAborted();
      const result: unknown = context.assertCurrentSync();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw unavailable();
      }
    };
    assertCurrentSync();
    return Object.freeze({
      ...context,
      signal: AbortSignal.any([context.signal, this.retired.signal]),
      assertCurrentSync,
    });
  }
  bindNativeContext(context: NativeHostToolContext): NativeHostToolContext {
    const scoped = this.bindContext(context);
    return Object.freeze({
      ...scoped,
      async assertCurrent() {
        scoped.assertCurrentSync();
        await context.assertCurrent();
        scoped.assertCurrentSync();
      },
    });
  }
  async request(context: NativeMainPublicationCall, raw: unknown) {
    const scoped = this.bindContext(context);
    const input = RequestGithubMainPublicationSchema.parse(raw);
    const work = new TelosWorkStore(this.database, {
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(this.events.getSession(id)),
      sourceConversation: (id) => isAvailableTelosSourceConversation(this.events.getSession(id)),
    });
    try {
      scoped.assertCurrentSync();
      const host = createTelosMainPublicationHost({
        registry: this.registry,
        events: this.events,
        work,
        context: scoped,
        select: this.selection.bind(scoped),
      });
      // The original operation retains its remote ACK before returning. Do not
      // erase a known result with a post-effect cancellation/currentness check.
      return await new TelosMainPublication(work, host).request(input, scoped.signal);
    } finally {
      try {
        work.close();
      } catch {
        createLogger('telos-publication').error('Canonical publication connection cleanup failed');
      }
    }
  }
  async withItems<T>(
    context: NativeHostToolContext,
    operation: (owners: {
      context: NativeHostToolContext;
      items: TelosItemStore;
      work: TelosWorkStore;
    }) => Promise<T>,
  ): Promise<T> {
    const scoped = this.bindNativeContext(context);
    const work = new TelosWorkStore(this.database, {
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(this.events.getSession(id)),
    });
    let items: TelosItemStore | undefined;
    try {
      items = new TelosItemStore(this.database);
      scoped.assertCurrentSync();
      return await operation({ context: scoped, items, work });
    } finally {
      for (const owner of [items, work]) {
        try {
          owner?.close();
        } catch {
          createLogger('telos-publication').error(
            'Canonical native item connection cleanup failed',
          );
        }
      }
    }
  }
  async withArtifacts<T>(
    context: NativeHostToolContext,
    operation: (owners: {
      context: NativeHostToolContext;
      artifacts: TelosArtifactStore;
      work: TelosWorkStore;
      sources: TelosSourceCapture;
      approvals: TelosSourceApprovalStore;
    }) => Promise<T>,
  ): Promise<T> {
    const scoped = this.bindNativeContext(context);
    const work = new TelosWorkStore(this.database, {
      ordinaryConversation: (id) => isAvailableTelosWorkConversation(this.events.getSession(id)),
      sourceConversation: (id) => isAvailableTelosSourceConversation(this.events.getSession(id)),
    });
    let artifacts: TelosArtifactStore | undefined;
    let approvals: TelosSourceApprovalStore | undefined;
    try {
      // Own the actual outer SQLite commit; no borrowed transaction is admitted.
      artifacts = new TelosArtifactStore(this.database);
      approvals = new TelosSourceApprovalStore(this.database);
      const sources = new TelosSourceCapture({
        events: this.events,
        work,
        artifacts,
        assertAuthorized: scoped.assertCurrentSync,
        authorizeSource: (actor, id) =>
          actor.kind === 'operator' &&
          actor.id === scoped.operatorId &&
          isAvailableTelosSourceConversation(this.events.getSession(id)),
        authorizeArtifact: (actor, id) =>
          actor.kind === 'operator' &&
          actor.id === scoped.operatorId &&
          artifacts!.userUploadAllowed(id),
      });
      scoped.assertCurrentSync();
      return await operation({ context: scoped, work, artifacts, sources, approvals });
    } finally {
      for (const owner of [approvals, artifacts, work]) {
        try {
          owner?.close();
        } catch {
          createLogger('telos-publication').error(
            'Canonical native tool connection cleanup failed',
          );
        }
      }
    }
  }
}
export function getTelosMainPublicationRuntime() {
  return active;
}
export function installTelosMainPublicationRuntime(
  owners: ConstructorParameters<typeof TelosMainPublicationRuntime>[0],
) {
  // Retire first: invalid replacement cannot leave an old credential grant live.
  active?.close();
  const next = new TelosMainPublicationRuntime(owners);
  active = next;
  return next;
}
export function initializeTelosMainPublicationRuntime(
  owners: {
    registry: SessionRegistry;
    events: EventStore;
    databasePath(): string;
  },
  path = process.env.MITZO_TELOS_MAIN_PUBLICATION_CONFIG_FILE,
) {
  active?.close();
  const config = path ? readTelosMainPublicationConfiguration(path) : { registrations: [] };
  return installTelosMainPublicationRuntime({
    ...owners,
    registrations: config.registrations,
    custodian: new PublicationCredentialCustodian(credentials),
  });
}
export function closeTelosMainPublicationRuntime() {
  active?.close();
}
