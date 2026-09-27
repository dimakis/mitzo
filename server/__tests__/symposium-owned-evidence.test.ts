import { operatorAuthMiddleware } from '../auth.js';
import { INTERNAL_TOKEN } from '../internal-token.js';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectOwnedAdmissionEvidence,
  invokeOwnedEvidenceCli,
  ownedEvidenceHandler,
} from '../symposium-owned-evidence.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from '../symposium-production-gate.js';

describe('owned admission evidence candidate', () => {
  it('measures local inputs and verifies all existing gates before returning; never installs evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'owned-evidence-'));
    try {
      writeFileSync(join(root, 'policy'), 'reviewed policy');
      mkdirSync(join(root, 'seed'));
      const custody = vi.fn();
      const verify = vi.fn();
      const invoke = vi.fn(() => JSON.stringify({ id: 'codex', provider: 'codex' }));
      const config = {
        cli: '/cli',
        gateway: 'fresh',
        workspace: 'workspace',
        policy: join(root, 'policy'),
        seed: join(root, 'seed'),
      } as never;
      const input = {
        providerInstances: [
          { name: 'personal', id: 'exact-id', type: 'codex', profileName: 'codex' },
        ],
        allowedRoles: ['reviewer'],
        allowedAccountProviders: ['openai-codex'],
        artifactVolume: { driver: 'podman', name: 'exact-volume' },
      };
      const candidate = collectOwnedAdmissionEvidence(
        { config, endpoint: 'https://localhost:1234', physical: {} as never, custody },
        input,
        { invoke, verify },
      );
      expect(candidate.image).toBe(TESTED_SYMPOSIUM_NATIVE_BUILD.image);
      expect(candidate.providerInstances).toEqual(input.providerInstances);
      expect(candidate.policySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(verify).toHaveBeenCalledWith(config, candidate, {}, invoke);
      expect(custody).toHaveBeenCalledTimes(2);
      verify.mockImplementation(() => {
        throw new Error('physical mismatch');
      });
      expect(() =>
        collectOwnedAdmissionEvidence(
          { config, endpoint: 'https://localhost:1234', physical: {} as never, custody },
          input,
          { invoke, verify },
        ),
      ).toThrow('physical mismatch');
      expect(() =>
        collectOwnedAdmissionEvidence(
          { config, endpoint: 'https://localhost:1234', physical: {} as never, custody },
          { ...input, image: 'caller-image' },
          { invoke, verify },
        ),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('candidate endpoint rejects caller authority and reports unavailable or failed proofs without activating', async () => {
  const app = express();
  app.use(express.json());
  const state: {
    collect?: ReturnType<
      typeof vi.fn<
        (selection: unknown) => Promise<ReturnType<typeof collectOwnedAdmissionEvidence>>
      >
    >;
  } = {};
  app.post(
    '/evidence',
    ownedEvidenceHandler(() => state.collect),
  );
  expect((await request(app).post('/evidence').send({})).status).toBe(503);
  state.collect = vi.fn(() => {
    throw new Error('private diagnostics');
  });
  expect((await request(app).post('/evidence').send({ image: 'override' })).status).toBe(400);
  expect(state.collect).not.toHaveBeenCalled();
  const selection = {
    providerInstances: [{ name: 'personal', id: 'exact-id', type: 'codex', profileName: 'codex' }],
    allowedRoles: ['reviewer'],
    allowedAccountProviders: ['openai-codex'],
    artifactVolume: { driver: 'podman', name: 'exact-volume' },
  };
  const failed = await request(app).post('/evidence').send(selection);
  expect(failed.status).toBe(409);
  expect(failed.text).not.toContain('private diagnostics');
  state.collect.mockResolvedValue({ candidateFixture: true } as never);
  const result = await request(app).post('/evidence').send(selection);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body).toEqual({ candidate: { candidateFixture: true }, activated: false });
});

it('operator endpoint refuses unauthenticated and internal-runtime callers before collection', async () => {
  const collect = vi.fn();
  const app = express();
  app.use(express.json());
  app.post(
    '/evidence',
    operatorAuthMiddleware,
    ownedEvidenceHandler(() => collect),
  );
  expect((await request(app).post('/evidence').send({})).status).toBe(403);
  expect(
    (await request(app).post('/evidence').set('x-internal-token', INTERNAL_TOKEN).send({})).status,
  ).toBe(403);
  expect(collect).not.toHaveBeenCalled();
});

it('trims actual command stdout for exact version comparisons', () => {
  expect(
    invokeOwnedEvidenceCli('/usr/bin/printf', ['openshell reviewed\n'], {
      HOME: '/tmp',
      XDG_CONFIG_HOME: '/tmp',
      PATH: '/usr/bin:/bin',
    }),
  ).toBe('openshell reviewed');
});
