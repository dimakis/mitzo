import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import type { LocalRepositoryGitMetadata } from '../local-repository-git-inspection.js';
import { captureLocalRepositoryPreparationObjects } from '../local-repository-preparation-objects.js';
import { parsePreparationObjectStoreCaptureOutput } from '../native-repository-object-store.js';
import { codexToolFailureResult } from '../codex-tool-failure.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fs.rm).mockImplementation(actual.rm);
  for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true });
});
it.each(['none', 'verify', 'dispose', 'both'] as const)(
  'retains actual native-store refusal through required preparation consumer and %s cleanup failure',
  async (mode) => {
    const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'mitzo-object-cause-consumer-')),
    );
    roots.push(root);
    await fs.writeFile(join(root, 'canary'), 'UNCHANGED SOURCE');
    let primary: unknown;
    try {
      parsePreparationObjectStoreCaptureOutput(
        { stdout: '{"error":"unavailable","check":"copy"}' },
        await fixtureReadAnchor(root),
      );
    } catch (error) {
      primary = error;
    }
    expect(primary).toBeDefined();
    let refused = false;
    const revalidate = vi.fn(async () => {
      if (refused && (mode === 'verify' || mode === 'both'))
        throw Object.assign(Error('PRIVATE verify'), { code: 'ETIMEDOUT' });
    });
    const capture = vi.fn(async () => {
      refused = true;
      throw primary;
    });
    const access = new LocalRepositoryReadAccess({
      deniedRoots: [],
      deadline: Date.now() + 30000,
      assertReadable: async () => {},
      captureReadAnchor: fixtureReadAnchor,
      revalidate,
      capturePreparationObjectStore: capture,
      verifyPreparationObjectStore: async () => {},
    });
    if (mode === 'dispose' || mode === 'both') {
      vi.mocked(fs.rm).mockImplementation(async (path) => {
        roots.push(String(path)); // Exact owned disposer path, retained for independent test cleanup.
        throw Object.assign(Error('PRIVATE disposal'), { code: 'ENOSPC' });
      });
    }
    let failure: unknown;
    try {
      // Only the facts consumed before this controlled refusal are supplied.
      // Real preparation/access/disposal owners run; no authorization is inferred.
      await captureLocalRepositoryPreparationObjects(
        { commonDirectory: root, objectFormat: 'sha1' } as LocalRepositoryGitMetadata,
        { readAccess: access, baseOid: 'a'.repeat(40), timeoutMs: 30000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(capture).toHaveBeenCalledOnce();
    if (mode === 'none') expect(failure).toBe(primary);
    const value = JSON.parse(
      codexToolFailureResult(failure, false, undefined, 'repository_preparation').content,
    );
    expect(value.diagnostic.effectStatus).toBe('unknown');
    expect(value.retry).toBe('after_reconciliation');
    expect((value.diagnostic.primary ?? value.diagnostic).check).toBe('object_store_capture_copy');
    if (mode !== 'none')
      expect(value.diagnostic.cleanup.map((item: { reason: string }) => item.reason)).toEqual(
        mode === 'both'
          ? ['deadline', 'storage_full']
          : mode === 'verify'
            ? ['deadline']
            : ['storage_full'],
      );
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
    expect(revalidate).toHaveBeenCalled();
    expect(await fs.readFile(join(root, 'canary'), 'utf8')).toBe('UNCHANGED SOURCE');
  },
);
it.each(['cancel', 'pending'] as const)(
  'preserves the final physical validation guard/join before scratch disposal: %s',
  async (mode) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'mitzo-object-cause-guard-')));
    roots.push(root);
    const controller = new AbortController();
    let primary: unknown;
    try {
      parsePreparationObjectStoreCaptureOutput(
        { stdout: '{"error":"unavailable","check":"copy"}' },
        await fixtureReadAnchor(root),
      );
    } catch (error) {
      primary = error;
    }
    let refused = false,
      validationStarted = false,
      settled = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access = new LocalRepositoryReadAccess({
      deniedRoots: [],
      deadline: Date.now() + 30000,
      assertReadable: async () => {},
      captureReadAnchor: fixtureReadAnchor,
      revalidate: async () => {
        if (refused) {
          validationStarted = true;
          await held;
        }
      },
      capturePreparationObjectStore: async () => {
        refused = true;
        if (mode === 'cancel') controller.abort();
        throw primary;
      },
      verifyPreparationObjectStore: async () => {},
    });
    vi.mocked(fs.rm).mockClear();
    const pending = captureLocalRepositoryPreparationObjects(
      { commonDirectory: root, objectFormat: 'sha1' } as LocalRepositoryGitMetadata,
      { readAccess: access, signal: controller.signal, baseOid: 'a'.repeat(40), timeoutMs: 30000 },
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    if (mode === 'pending') {
      await vi.waitFor(() => expect(validationStarted).toBe(true));
      vi.useFakeTimers();
      try {
        await vi.advanceTimersByTimeAsync(10001);
        expect(settled).toBe(false);
        expect(fs.rm).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        release();
      }
    }
    const error = await pending;
    const value = JSON.parse(
      codexToolFailureResult(error, false, undefined, 'repository_preparation').content,
    );
    expect(value.diagnostic.effectStatus).toBe('unknown');
    expect((value.diagnostic.primary ?? value.diagnostic).check).toBe('object_store_capture_copy');
    expect(validationStarted).toBe(mode === 'pending');
    if (mode === 'cancel') expect(value.error).toBe('cancelled');
    else expect(error).toBe(primary);
    expect(fs.rm).toHaveBeenCalledOnce();
  },
);
