import { createConnectionsRuntime } from '../connections-runtime.js';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  capabilityOperationStore,
  trackCapabilityOperation,
  closeCapabilityOperationStores,
} from '../capability-operation-owner.js';
it.each(['connection-first', 'publication-first'])(
  'shares canonical SQLite custody %s and drains before global close',
  async (order) => {
    const directory = mkdtempSync(join(tmpdir(), 'capability-owner-'));
    const alias = `${directory}-alias`;
    symlinkSync(directory, alias);
    try {
      const createConnections = () =>
        createConnectionsRuntime({
          directory,
          eligibleAccountIds: () => [],
          cli: '/unused-test-cli',
          workspace: 'fixture',
        });
      const runtime = order === 'connection-first' ? createConnections() : undefined;
      const first = capabilityOperationStore(directory);
      const connections = runtime ?? createConnections();
      expect(connections.capabilityStore).toBe(first);
      expect(capabilityOperationStore(alias)).toBe(first);
      first.upsertGrant({
        connectionId: 'selected',
        connectionRevision: 1,
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        accountIds: ['operator'],
        status: 'active',
      });
      let finish!: () => void;
      const pending = trackCapabilityOperation(
        first,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      let closed = false;
      const closing = closeCapabilityOperationStores(new AbortController().signal).then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await expect(trackCapabilityOperation(first, async () => {})).rejects.toThrow('draining');
      finish();
      await pending;
      await closing;
      const reopened = capabilityOperationStore(directory);
      expect(reopened).not.toBe(first);
      expect(reopened.grants('selected')).toHaveLength(1);
      await closeCapabilityOperationStores(new AbortController().signal);
      connections.store.close();
    } finally {
      unlinkSync(alias);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
