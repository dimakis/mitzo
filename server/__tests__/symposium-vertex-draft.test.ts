import type { Request, Response } from 'express';
import { expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { createSymposiumSessionRouter } from '../symposium-session-create.js';

it('refuses Vertex draft by default and admits only through original host capability before allocating', async () => {
  const store = new EventStore(':memory:');
  const profiles = new SymposiumProfileStore(':memory:');
  const accounts = new AccountProfiles([
    {
      id: 'stage-vertex',
      label: 'Stage Vertex',
      provider: 'anthropic-vertex',
      projectId: 'stage-project',
      region: 'stage-region',
      credentialRef: '/offline/unused-adc.json',
      sandboxProvider: 'stage-vertex-provider',
      sandboxProviderId: 'stage-vertex-id',
      models: [{ id: 'claude-fixture', label: 'Offline fixture' }],
    },
  ]);
  profiles.save('user', {
    profileId: 'fixture-reader',
    expectedRevision: 0,
    idempotencyKey: 'seed',
    definition: {
      name: 'Fixture reader',
      role: 'reviewer',
      instructions: 'Read fixture',
      expectedOutput: 'Fixture text',
      acceptanceCriteria: ['Exact nonce'],
      modelPolicyRole: 'reviewer',
    },
  });
  const body = {
    idempotencyKey: 'fixture-create',
    title: 'Offline staging draft',
    accountId: 'stage-vertex',
    model: 'claude-fixture',
    role: 'reviewer',
    profileSelection: { profileId: 'fixture-reader', revision: 1 },
  };
  const deps = {
    store,
    profiles,
    currentAccounts: () => accounts,
    newSessionId: () => 'stage-fixture',
  };
  try {
    expect((await dispatch(createSymposiumSessionRouter(deps), body)).status).toBe(409);
    expect(store.listSessions()).toHaveLength(0);
    const assertVertexDraftAvailable = vi.fn(() => {
      throw new Error('Actual reviewed Vertex host unavailable');
    });
    expect(
      (await dispatch(createSymposiumSessionRouter({ ...deps, assertVertexDraftAvailable }), body))
        .status,
    ).toBe(409);
    expect(store.listSessions()).toHaveLength(0);
    assertVertexDraftAvailable.mockImplementation(() => {});
    expect(
      (await dispatch(createSymposiumSessionRouter({ ...deps, assertVertexDraftAvailable }), body))
        .status,
    ).toBe(201);
    expect(assertVertexDraftAvailable).toHaveBeenLastCalledWith(
      accounts.resolve(body.accountId, body.model),
    );
    const config = JSON.parse(store.getSession('stage-fixture')!.symposiumConfig!);
    expect(config.state).toBe('draft');
    expect(config.seats[0].accountBinding.provider).toBe('anthropic-vertex');
    expect(store.getSymposiumDeliveries('stage-fixture')).toEqual([]);
    expect(store.getSymposiumMembershipHistory('stage-fixture')).toEqual([]);
  } finally {
    profiles.close();
    store.close();
  }
});
function dispatch(
  router: ReturnType<typeof createSymposiumSessionRouter>,
  body: unknown,
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
    (
      router as typeof router & {
        handle(req: Request, res: Response, next: (error?: unknown) => void): void;
      }
    ).handle(
      { method: 'POST', url: '/', body } as Request,
      response as unknown as Response,
      (error) => reject(error ?? new Error('Route missing')),
    );
  });
}
