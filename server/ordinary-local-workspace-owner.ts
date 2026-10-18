import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  HostRepositoryReservationInput,
  RepositoryWorkspace,
  RepositoryWorkspaces,
} from './repository-workspaces.js';
import type { OrdinaryWorkspaceRecord } from './ordinary-workspace-custody.js';

export type LocalWorkspaceKind = 'repository' | 'ordinary';
export type LocalWorkspaceRecord<K extends LocalWorkspaceKind = 'repository'> = K extends 'ordinary'
  ? OrdinaryWorkspaceRecord
  : RepositoryWorkspace;
export type LocalWorkspaceReservation = Omit<HostRepositoryReservationInput, 'signal'>;
const unavailable = () => new Error('Original local workspace custody unavailable');

/** Private policy adapter over the existing allocation owner. Kind originates in
 * the server composition and must agree with durable session/preparation identity. */
export class OrdinaryLocalWorkspaceOwner<K extends LocalWorkspaceKind = 'repository'> {
  constructor(
    private workspace: RepositoryWorkspaces,
    readonly kind: K,
    private reservation: LocalWorkspaceReservation,
  ) {}
  get(): LocalWorkspaceRecord<K> {
    const r = this.reservation;
    const value =
      this.kind === 'ordinary'
        ? this.workspace.getOrdinaryWorkspace(r.id)
        : this.workspace.getHostReservation(r);
    if (this.kind === 'ordinary') {
      const ordinary = value as OrdinaryWorkspaceRecord;
      if (
        ordinary.kind !== 'ordinary' ||
        ordinary.id !== r.id ||
        ordinary.conversationId !== r.conversationId ||
        !isDeepStrictEqual(ordinary.binding, r.binding) ||
        !isDeepStrictEqual(ordinary.settings.binding, r.runtimeBinding) ||
        ordinary.preparationFingerprint !== r.commandFingerprint ||
        ordinary.hostReservation.taskRoot !== r.taskRoot
      )
        throw unavailable();
    }
    return value as LocalWorkspaceRecord<K>;
  }
  assertCurrentSync(cwd: string): void {
    const reservation = this.reservation;
    if (this.kind === 'ordinary') {
      const descriptor = this.get() as OrdinaryWorkspaceRecord;
      if (descriptor.directory !== cwd || !['reserved', 'claimed'].includes(descriptor.state))
        throw unavailable();
      const root = lstatSync(reservation.taskRoot);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        realpathSync(reservation.taskRoot) !== reservation.taskRoot ||
        (root.mode & 0o077) !== 0 ||
        root.uid !== process.getuid?.() ||
        root.dev !== descriptor.hostReservation.rootIdentity.dev ||
        root.ino !== descriptor.hostReservation.rootIdentity.ino
      )
        throw unavailable();
      if (descriptor.state === 'claimed')
        this.workspace.validateOrdinaryWorkspace(reservation.conversationId, cwd);
      return;
    }
    const descriptor = this.workspace.getHostReservation(reservation);
    if (
      !isDeepStrictEqual(descriptor.binding, reservation.binding) ||
      descriptor.conversationId !== reservation.conversationId ||
      descriptor.id !== reservation.id ||
      descriptor.directory !== cwd ||
      descriptor.hostReservation.taskRoot !== reservation.taskRoot ||
      !['reserved', 'claimed'].includes(descriptor.state)
    )
      throw unavailable();
    const root = lstatSync(reservation.taskRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      realpathSync(reservation.taskRoot) !== reservation.taskRoot ||
      root.dev !== descriptor.hostReservation.rootIdentity.dev ||
      root.ino !== descriptor.hostReservation.rootIdentity.ino
    )
      throw unavailable();
    if (descriptor.state === 'claimed') {
      // The existing repository ledger owns the materialized checkout identity.
      // Do not accept another directory merely because its reservation path matches.
      const claimed = this.workspace.getForConversation(reservation.conversationId);
      const identity = claimed?.taskIdentity;
      if (
        !claimed ||
        claimed.id !== descriptor.id ||
        claimed.conversationId !== descriptor.conversationId ||
        claimed.directory !== descriptor.directory ||
        claimed.sandbox ||
        !isDeepStrictEqual(claimed.binding, reservation.binding) ||
        claimed.featureBranch !== descriptor.featureBranch ||
        !identity ||
        identity.directory !== descriptor.directory ||
        identity.featureBranch !== claimed.featureBranch
      )
        throw unavailable();
      for (const [path, retained] of [
        [identity.directory, identity.root],
        [join(identity.directory, '.git'), identity.git],
      ] as const) {
        const current = lstatSync(path);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          realpathSync(path) !== path ||
          current.dev !== retained.dev ||
          current.ino !== retained.ino
        )
          throw unavailable();
      }
    }
  }
  async revalidate(signal: AbortSignal): Promise<void> {
    const record = this.get();
    if (this.kind === 'ordinary') {
      await this.workspace.revalidateOrdinaryWorkspace({
        ...structuredClone(this.reservation),
        signal,
      });
    } else await this.workspace.reserveHostTask({ ...structuredClone(this.reservation), signal });
    this.assertCurrentSync(record.directory!);
    if (record.state === 'claimed') await this.validate(record.directory!);
  }
  async validate(cwd: string): Promise<void> {
    this.assertCurrentSync(cwd);
    if (this.kind === 'ordinary')
      this.workspace.validateOrdinaryWorkspace(this.reservation.conversationId, cwd);
    else await this.workspace.validateHostTask(this.reservation.conversationId, cwd);
    this.assertCurrentSync(cwd);
  }
  async claim(signal: AbortSignal): Promise<LocalWorkspaceRecord<K>> {
    if (this.kind === 'ordinary')
      await this.workspace.claimOrdinaryWorkspace({ ...structuredClone(this.reservation), signal });
    else
      await this.workspace.claimReservedHostTask({ ...structuredClone(this.reservation), signal });
    return this.get();
  }
}
