import { afterEach, expect, it, vi } from 'vitest';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { createCollaborationRetainedArtifactPort } from '../collaboration-retained-artifact-port.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture(owned = true) {
  const f = createCollaborationRetainedArtifactFixture(owned);
  cleanups.push(() => f.close());
  const saved = f.store.save({
    itemId: f.itemId,
    filename: 'design.md',
    title: 'Exact design',
    bytes: Buffer.from('\uFEFFcafé • 台灣\r\n'),
    sessionId: 'removed-origin',
    sourcePath: '/private/original.md',
  });
  const port = createCollaborationRetainedArtifactPort(() => f.path);
  cleanups.push(() => port.close());
  const pin = { artifactId: saved.id, revision: saved.revision, sha256: saved.sha256 };
  let authorized = true;
  const source = port.source(() => {
    if (!authorized) throw Error('Current artifact authority revoked');
  });
  const read = () => f.selectOwner(() => source.read(pin));
  return {
    ...f,
    port,
    pin,
    read,
    revoke: () => {
      authorized = false;
    },
  };
}
it('borrows actual read-only retained custody and renews it synchronously without the source transcript', async () => {
  const f = fixture();
  const saved = await f.read();
  expect(saved.bytes).toEqual(Buffer.from('\uFEFFcafé • 台灣\r\n'));
  expect(saved.provenance.sessionId).toBe('removed-origin');
  expect(() => saved.assertCurrent()).not.toThrow();
  f.revoke();
  expect(() => saved.assertCurrent()).toThrow('authority revoked');
  await expect(f.read()).rejects.toThrow('authority revoked');
});
it('refuses an unqualified legacy handle rather than inventing a custody renewal', async () => {
  const f = fixture(false);
  await expect(f.read()).rejects.toThrow('Retained Telos database ownership unavailable');
});
it('propagates unexpected source storage failures and exposes no successful read', async () => {
  const f = fixture();
  const error = Error('Synthetic artifact storage programming failure');
  vi.spyOn(TelosArtifactStore.prototype, 'metadataForRevision').mockImplementationOnce(() => {
    throw error;
  });
  await expect(f.read()).rejects.toBe(error);
});
it('never opens the canonical store for context without a selected retained artifact', () => {
  const path = vi.fn(() => {
    throw Error('No canonical artifact store configured');
  });
  const port = createCollaborationRetainedArtifactPort(path);
  port.source(() => {
    throw Error('No artifact read requested');
  });
  expect(path).not.toHaveBeenCalled();
  port.close();
});
