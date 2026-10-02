import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from '../symposium-owned-runtime-contract.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from '../symposium-production-gate.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
import {
  SYMPOSIUM_ARTIFACT_TARGET,
  type ArtifactVolumeEvidence,
} from '../symposium-artifact-lease.js';
import { artifactGitContract } from '../symposium-artifact-initializer.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
it('derives admission, owner and artifact target from the same owned contract', () => {
  const { build, workload } = REVIEWED_SYMPOSIUM_OWNED_RUNTIME;
  expect(TESTED_SYMPOSIUM_NATIVE_BUILD).toBe(build);
  expect(symposiumArtifactOwner(build.image)).toEqual({
    image: build.image,
    uid: workload.uid,
    gid: workload.gid,
  });
  expect(SYMPOSIUM_ARTIFACT_TARGET).toBe(workload.workdir);
  expect(() => symposiumArtifactOwner('sha256:' + '0'.repeat(64))).toThrow('not reviewed');
});
it.each(['missing', 'drift'])(
  'rejects a %s target receipt on reopen without recreating or replacing the volume',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-compatibility-'));
    const volumes = new Map<string, ArtifactVolumeEvidence>();
    const contract = artifactGitContract(
      symposiumArtifactOwner(REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build.image),
    );
    let creates = 0;
    const host = {
      initializationContract: contract,
      inspect: async (name: string) => volumes.get(name) ?? null,
      create: async (name: string, labels: Record<string, string>) => {
        creates++;
        volumes.set(name, { name, labels, driver: 'local', options: {} });
      },
    };
    let store = new SymposiumSessionArtifacts(
      join(root, 'ledger.db'),
      'workspace',
      'custody',
      () => {},
      host,
    );
    try {
      expect(await store.ensure('session')).toEqual({ state: 'ready' });
      const retained = store.getReady('session');
      store.close();
      const db = new Database(join(root, 'ledger.db'));
      const incompatible = JSON.parse(contract);
      if (kind === 'missing') delete incompatible.target;
      else incompatible.target = '/sandbox/other-workdir';
      db.prepare('UPDATE symposium_session_artifacts SET initialization_contract=?').run(
        JSON.stringify(incompatible),
      );
      db.close();
      store = new SymposiumSessionArtifacts(
        join(root, 'ledger.db'),
        'workspace',
        'custody',
        () => {},
        host,
      );
      expect(store.getReady('session')).toBeNull();
      expect(await store.ensure('session')).toEqual({ state: 'recovery_required' });
      expect(store.getRetained('session')).toEqual(retained);
      expect(creates).toBe(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
