import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { createStagingFeatureRouter } from '../staging-feature-router.js';
it('missing original owner remains unavailable before all feature effects', async () => {
  const response = await dispatch(() => undefined, 'POST', '/plan', {});
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'Qualified staging feature owner unavailable' });
});
it('rejects model/prompt overrides before the trusted owner is invoked', async () => {
  const plan = vi.fn();
  const response = await dispatch(() => ({ plan }) as never, 'POST', '/plan', {
    request: {},
    sourceCommit: 'a'.repeat(40),
    model: 'gpt-6-sol',
    prompt: 'arbitrary',
  });
  expect(response.status).toBe(400);
  expect(plan).not.toHaveBeenCalled();
});
it('projects only owner-enrolled metadata and drops private failures', async () => {
  const enrollment = vi.fn(() => ({ profileId: 'stage-work', enrollmentRevision: 'b'.repeat(64) }));
  expect(
    (await dispatch(() => ({ enrollment }) as never, 'GET', '/enrollments/stage-work')).body,
  ).toEqual({ profileId: 'stage-work', enrollmentRevision: 'b'.repeat(64) });
  enrollment.mockImplementationOnce(() => {
    throw new Error('/private/credential/path');
  });
  const failure = await dispatch(() => ({ enrollment }) as never, 'GET', '/enrollments/stage-work');
  expect(failure.status).toBe(409);
  expect(JSON.stringify(failure.body)).not.toContain('private');
});

function dispatch(
  owner: Parameters<typeof createStagingFeatureRouter>[0],
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const response = {
      status: (value: number) => {
        status = value;
        return response;
      },
      json: (value: unknown) => resolve({ status, body: value }),
    };
    const router = createStagingFeatureRouter(owner) as ReturnType<
      typeof createStagingFeatureRouter
    > & { handle(req: Request, res: Response, next: (error?: unknown) => void): void };
    router.handle({ method, url, body } as Request, response as unknown as Response, (error) =>
      reject(error ?? new Error('Route missing')),
    );
  });
}

it('exposes original resource observations only through the retained source capability', async () => {
  expect((await dispatch(() => ({}) as never, 'GET', '/resources')).status).toBe(503);
  const resources = vi.fn(() => ({ sourceCommit: 'a'.repeat(40), ownerInstance: 'original' }));
  expect((await dispatch(() => ({ resources }) as never, 'GET', '/resources')).body).toEqual({
    sourceCommit: 'a'.repeat(40),
    ownerInstance: 'original',
  });
});
