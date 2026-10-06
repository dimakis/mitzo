import type { SQLiteBackupOwner } from '@mitzo/protocol/database-backup';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { captureMitzoTelosCore } from './mitzo-telos.js';

/** Trusted host binding only. Constructing it opens no additional database and
 * schedules no capture; never expose its destination parameter as an HTTP input.
 */
export function bindMitzoTelosCoreCapture(options: {
  events: SQLiteBackupOwner;
  tasks: SQLiteBackupOwner;
  telosPath(): string;
}): (destination: string) => Promise<void> {
  return async (destination) => {
    let telos: TelosArtifactStore | undefined;
    try {
      // Same canonical owner and configured path as Telos artifact operations.
      // fileMustExist prevents inventing an empty database as successful coverage.
      telos = new TelosArtifactStore(options.telosPath());
      await captureMitzoTelosCore({
        destination,
        owners: { events: options.events, tasks: options.tasks, telos },
      });
    } catch {
      throw Error('Mitzo/Telos backup unavailable');
    } finally {
      telos?.close();
    }
  };
}
