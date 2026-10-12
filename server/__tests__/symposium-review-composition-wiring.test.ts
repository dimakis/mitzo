import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { beforeEach, expect, it, vi } from 'vitest';
import type { createSymposiumReviewRouter } from '../symposium-review-routes.js';
import type { SymposiumReviewRouteHost } from '../symposium-review-host-contract.js';
import type { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
import { createSymposiumReviewRouteComposition } from '../symposium-review-route-composition.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const seams = vi.hoisted(() => ({ router: vi.fn(), preflight: vi.fn() }));
vi.mock('../symposium-review-routes.js', () => ({
  createSymposiumReviewRouter: (deps: unknown) => {
    seams.router(deps);
    return Router({ mergeParams: true });
  },
}));
vi.mock('../symposium-review-publication.js', () => ({
  createSymposiumReviewPublicationPreflight: seams.preflight,
}));
vi.mock('../app.js', () => {
  throw Error('Application bootstrap imported');
});
vi.mock('../chat.js', () => {
  throw Error('Chat bootstrap imported');
});
vi.mock('../internal-token.js', () => ({ isValidInternalToken: () => false }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
beforeEach(() => {
  vi.clearAllMocks();
});

function fixture() {
  const store = {} as SymposiumReviewStore;
  let host: SymposiumReviewRouteHost | undefined;
  const runtime = vi.fn((): object | null => ({}));
  const hasSession = vi.fn(() => true);
  createSymposiumReviewRouteComposition({
    store,
    actionAuthority: new SymposiumReviewActionAuthority(),
    currentHost: () => host,
    runtime,
    hasSession,
  });
  const callbacks = seams.router.mock.calls[0][0] as Parameters<
    typeof createSymposiumReviewRouter
  >[0];
  return {
    store,
    runtime,
    hasSession,
    callbacks,
    select(value: typeof host) {
      host = value;
    },
  };
}

it('retains the existing store and exact-session predicate without constructing owners', () => {
  const f = fixture();
  expect(f.callbacks.store).toBe(f.store);
  expect(f.callbacks.hasSession).toBe(f.hasSession);
  expect(f.runtime).not.toHaveBeenCalled();
});

it('resolves installed review hosts on demand and requires a current runtime', () => {
  const f = fixture();
  expect(f.callbacks.getHost('session')).toBeNull();
  expect(f.runtime).not.toHaveBeenCalled();
  const first = { reviewHost: {} } as SymposiumReviewRouteHost;
  f.select(first);
  expect(f.callbacks.getHost('session')).toBe(first.reviewHost);
  expect(f.runtime).toHaveBeenLastCalledWith('session');
  const second = { reviewHost: {} } as SymposiumReviewRouteHost;
  f.select(second);
  expect(f.callbacks.getHost('other')).toBe(second.reviewHost);
  f.runtime.mockReturnValue(null);
  expect(f.callbacks.getHost('session')).toBeNull();
});

it('selects publication dependencies only when both trusted bindings and runtime exist', () => {
  const f = fixture();
  const get = f.callbacks.getPublicationPreflight!;
  expect(get('session')).toBeNull();
  f.select({ reviewHost: {} } as SymposiumReviewRouteHost);
  expect(get('session')).toBeNull();
  f.select({ reviewPublication: {} } as SymposiumReviewRouteHost);
  expect(get('session')).toBeNull();
  expect(f.runtime).not.toHaveBeenCalled();
  const publication = { workspaceId: 'trusted-workspace', store: 'caller-must-not-replace-owner' };
  f.select({
    reviewHost: {},
    reviewPublication: publication,
  } as unknown as SymposiumReviewRouteHost);
  f.runtime.mockReturnValue(null);
  expect(get('session')).toBeNull();
  expect(seams.preflight).not.toHaveBeenCalled();
  f.runtime.mockReturnValue({});
  const selected = { inspect: vi.fn() };
  seams.preflight.mockReturnValue(selected);
  expect(get('session')).toBe(selected);
  expect(seams.preflight).toHaveBeenLastCalledWith({ ...publication, store: f.store });
  f.select({
    reviewHost: {},
    reviewPublication: { workspaceId: 'second' },
  } as SymposiumReviewRouteHost);
  get('session');
  expect(seams.preflight).toHaveBeenLastCalledWith({ workspaceId: 'second', store: f.store });
});

it('defines the physical review host independently of application bootstrap', () => {
  const composition = readFileSync(
    new URL('../symposium-production-review-composition.ts', import.meta.url),
    'utf8',
  );
  const contract = readFileSync(
    new URL('../symposium-review-host-contract.ts', import.meta.url),
    'utf8',
  );
  expect(composition).not.toMatch(/from ['"]\.\/app\.js['"]/);
  expect(composition).toContain('SymposiumReviewPhysicalHost');
  expect(contract).not.toMatch(/from ['"]\.\/app\.js['"]/);
});

it('binds request and physical review composition to the reviewed runtime source manifest', () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    'symposium-review-route-composition',
    'symposium-review-host-contract',
    'symposium-production-review-composition',
  ]) {
    const source = readFileSync(new URL(`../${file}.ts`, import.meta.url), 'utf8');
    expect(artifacts[`../${file}.ts`]).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
