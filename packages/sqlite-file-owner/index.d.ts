import type Database from 'better-sqlite3';

declare const retainedLease: unique symbol;
export interface NativeFileLease {
  readonly [retainedLease]: true;
}
/** Denial only; checks the actual main-thread/singleton boundary without opening any FD. */
export function assertLeaseAdmission(): void;
export function reserveFamily(): NativeFileLease;
export function openReservedLease(reservation: NativeFileLease, filename: string): void;
declare const connectionLifetime: unique symbol;
export interface NativeConnectionLifetime {
  readonly [connectionLifetime]: true;
}
/** Exclusion only. Release only after the actual ordinary SQLite connection closes. */
export function retainUnqualifiedConnection(): NativeConnectionLifetime;
export function releaseUnqualifiedConnection(handle: NativeConnectionLifetime): void;
export function openLease(filename: string): NativeFileLease;
/** Shared=0, exclusive=1, unlock=2; never blocks. */
export function lockLease(handle: NativeFileLease, mode: 0 | 1 | 2): void;
export function closeLease(handle: NativeFileLease): void;
/** Kernel fstat of the retained descriptor, not a pathname observation. */
export function leaseIdentity(handle: NativeFileLease): { device: string; inode: string };
/** Current-handle observation only; it does not establish retained history. */
export function installCurrentFileProbe(database: Database.Database): void;
