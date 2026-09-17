import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityTemplate, JsonSchema, JsonValue } from '../connections/types.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
import { CapabilityExecutorRegistry } from '../connections/capabilities/registry.js';
import { CapabilityService } from '../connections/capabilities/service.js';
import { bindCapabilityExecution } from '../connections/capabilities/direct.js';
import { capabilityApprovalPayload } from '../connections/capabilities/approval.js';

const template: CapabilityTemplate = {
  id: 'test.mutate',
  version: 1,
  label: 'Test mutate',
  description: 'A deterministic test executor.',
  connectionTemplateIds: ['test-provider'],
  executor: 'test-mutate-v1',
  approval: 'always',
  idempotency: 'required',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string', maxLength: 100 }, flag: { type: 'boolean' } },
    required: ['value'],
    additionalProperties: false,
  },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { approved?: boolean; active?: boolean; revision?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mitzo-capability-'));
  directories.push(dir);
  const store = new CapabilityOperationStore(join(dir, 'capabilities.db'));
  const connection = {
    id: 'connection-1',
    templateId: 'test-provider',
    templateVersion: 1,
    revision: options.revision ?? 7,
    status: 'active',
    desiredAccountIds: ['account-1'],
  };
  const grant = store.upsertGrant({
    connectionId: connection.id,
    connectionRevision: connection.revision,
    capabilityId: template.id,
    capabilityVersion: template.version,
    accountIds: ['account-1'],
    status: 'active',
  });
  const execute = vi.fn(async (): Promise<{ output: JsonValue; externalResultId: string }> => ({
    output: { ok: true, echo: 'safe' },
    externalResultId: 'external-1',
  }));
  const verify = vi.fn(async () => {});
  const recover = vi.fn(async () => {});
  const approve = vi.fn(async () => options.approved ?? true);
  let active = options.active ?? true;
  const service = new CapabilityService({
    store,
    executorRegistry: new CapabilityExecutorRegistry({
      'test-mutate-v1': { execute, verify, recover },
    }),
    getTemplate: (id, version) =>
      id === template.id && version === template.version ? template : undefined,
    getConnection: (id) => (id === connection.id ? connection : undefined),
    listConnections: () => [connection],
    isConnectionActiveForConversation: (id, account, conversation) =>
      active &&
      id === connection.id &&
      account === 'account-1' &&
      conversation === 'conversation-1',
    approve,
  });
  return {
    store,
    connection,
    grant,
    service,
    execute,
    verify,
    recover,
    approve,
    setActive: (next: boolean) => {
      active = next;
    },
  };
}
function request(overrides: Record<string, unknown> = {}) {
  return {
    capabilityId: template.id,
    capabilityVersion: 1,
    connectionId: 'connection-1',
    connectionRevision: 7,
    accountId: 'account-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    idempotencyKey: 'request-1',
    input: { value: 'hello', flag: true },
    ...overrides,
  };
}

describe('CapabilityService', () => {
  it('atomically replays an idempotency key without duplicating a mutation and reconnect reads one result', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      f.service.invoke(request(), new AbortController().signal),
      f.service.invoke(request(), new AbortController().signal),
    ]);
    expect(first.id).toBe(second.id);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.approve).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('succeeded');
    expect(f.service.getOperation(first.id, 'account-1', 'conversation-1')).toEqual(first);
    expect(f.service.getOperation(first.id, 'account-2', 'conversation-1')).toBeUndefined();
    expect(f.service.getOperation(first.id, 'account-1', 'conversation-2')).toBeUndefined();
    const replay = await f.service.invoke(
      request({ turnId: 'turn-reconnect' }),
      new AbortController().signal,
    );
    expect(replay).toEqual(first);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects denied and cancelled requests before any external call', async () => {
    const denied = await fixture({ approved: false });
    await expect(
      denied.service.invoke(request(), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'denied', failureCode: 'DENIED' });
    expect(denied.execute).not.toHaveBeenCalled();
    const cancelled = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelled.service.invoke(request({ idempotencyKey: 'cancelled' }), controller.signal),
    ).rejects.toThrow();
    expect(cancelled.execute).not.toHaveBeenCalled();
  });

  it('fails closed on malformed input, stale revisions, grants, and cross-account/conversation state', async () => {
    const f = await fixture();
    await expect(
      f.service.invoke(
        request({ input: { value: 'ok', unknown: 'no' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid capability input');
    await expect(
      f.service.invoke(request({ connectionRevision: 6 }), new AbortController().signal),
    ).rejects.toThrow('unavailable');
    f.connection.desiredAccountIds = [];
    await expect(
      f.service.invoke(request({ idempotencyKey: 'cross-account' }), new AbortController().signal),
    ).rejects.toThrow('unavailable');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not advertise a grant from an older connection revision', async () => {
    const f = await fixture();
    f.connection.revision += 1;
    expect(f.service.eligibleToolsForConversation('account-1', 'conversation-1')).toEqual([]);
  });

  it('rejects a manually supplied wide optional schema before permission is requested', async () => {
    const f = await fixture();
    const wideInputSchema: JsonSchema = {
      type: 'object',
      properties: {
        ...template.inputSchema.properties,
        ...Object.fromEntries(
          Array.from({ length: 547 }, (_, index) => [
            `actionableFlag${index}`,
            { type: 'boolean' as const },
          ]),
        ),
      },
      required: ['value'],
      additionalProperties: false,
    };
    const wideTemplate = { ...template, inputSchema: wideInputSchema };
    const service = new CapabilityService({
      store: f.store,
      executorRegistry: new CapabilityExecutorRegistry({
        'test-mutate-v1': { execute: f.execute, verify: f.verify, recover: f.recover },
      }),
      getTemplate: (id, version) =>
        id === template.id && version === template.version ? wideTemplate : undefined,
      getConnection: (id) => (id === f.connection.id ? f.connection : undefined),
      listConnections: () => [f.connection],
      isConnectionActiveForConversation: () => true,
      approve: f.approve,
    });
    await expect(
      service.invoke(
        request({ idempotencyKey: 'wide-optional-schema', input: { value: 'hello' } }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('cannot fit a complete approval projection');
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('advertises only the already-verified attached connection during startup discovery', async () => {
    const f = await fixture();
    expect(
      f.service.eligibleToolsForManagedConnection('account-1', {
        id: 'connection-1',
        revision: 7,
      }),
    ).toEqual([
      {
        capabilityId: template.id,
        capabilityVersion: template.version,
        connectionId: 'connection-1',
        connectionRevision: 7,
      },
    ]);
    expect(
      f.service.eligibleToolsForManagedConnection('account-1', {
        id: 'connection-1',
        revision: 8,
      }),
    ).toEqual([]);
  });

  it('never persists request values or executor secrets in output, errors, or audit rows', async () => {
    const f = await fixture();
    const secret = 'SENTINEL_SECRET_987';
    f.execute.mockResolvedValueOnce({
      output: {
        token: secret,
        message: `echo ${secret}`,
        nested: { authorization: `Bearer ${secret}` },
      },
      externalResultId: 'external-safe',
    });
    const result = await f.service.invoke(
      request({ input: { value: secret } }),
      new AbortController().signal,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('Bearer ' + secret);
    expect(result).toMatchObject({
      status: 'succeeded',
      result: { token: '[REDACTED]', message: 'echo [REDACTED]' },
    });
  });

  it('cancels at the approval boundary if trusted lifecycle access was removed', async () => {
    const f = await fixture();
    f.approve.mockImplementationOnce(async () => {
      f.setActive(false);
      return true;
    });
    const result = await f.service.invoke(request(), new AbortController().signal);
    expect(result).toMatchObject({ status: 'cancelled', failureCode: 'STALE_ACCESS' });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('rechecks the exact active grant after approval before dispatch', async () => {
    const f = await fixture();
    f.approve.mockImplementationOnce(async () => {
      f.store.upsertGrant({
        connectionId: f.connection.id,
        connectionRevision: f.connection.revision,
        capabilityId: template.id,
        capabilityVersion: template.version,
        accountIds: ['account-1'],
        status: 'revoked',
      });
      return true;
    });
    await expect(f.service.invoke(request(), new AbortController().signal)).resolves.toMatchObject({
      status: 'cancelled',
      failureCode: 'STALE_ACCESS',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('preserves a post-write abort for read-after-write recovery without another mutation', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.execute.mockImplementationOnce(async () => {
      controller.abort();
      return { output: { ok: true }, externalResultId: 'external-1' };
    });
    const interrupted = await f.service.invoke(request(), controller.signal);
    expect(interrupted.status).toBe('verification_pending');
    const recovered = await f.service.invoke(
      request({ turnId: 'reconnect' }),
      new AbortController().signal,
    );
    expect(recovered.status).toBe('succeeded');
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps a remote write that throws recoverable and never retries its executor', async () => {
    const f = await fixture();
    f.execute.mockImplementationOnce(async () => {
      throw new Error('remote write completed before the response disconnected');
    });
    const initial = await f.service.invoke(request(), new AbortController().signal);
    expect(initial).toMatchObject({ status: 'verification_pending' });
    const recovered = await f.service.invoke(
      request({ turnId: 'restart' }),
      new AbortController().signal,
    );
    expect(recovered).toMatchObject({ status: 'succeeded' });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.recover).toHaveBeenCalledTimes(1);
  });

  it('recovers durable ambiguous writes on restart through read-after-write only', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.execute.mockImplementationOnce(async () => {
      controller.abort();
      return { output: { ok: true }, externalResultId: 'external-1' };
    });
    await f.service.invoke(request(), controller.signal);
    const restarted = new CapabilityService({
      store: f.store,
      executorRegistry: new CapabilityExecutorRegistry({
        'test-mutate-v1': { execute: f.execute, verify: f.verify, recover: f.recover },
      }),
      getTemplate: (id, version) => (id === template.id && version === 1 ? template : undefined),
      getConnection: (id) => (id === f.connection.id ? f.connection : undefined),
      listConnections: () => [f.connection],
      isConnectionActiveForConversation: () => true,
      approve: f.approve,
    });
    await expect(restarted.recoverPending(new AbortController().signal)).resolves.toHaveLength(1);
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('leaves verification pending when a restart has no compatible executor yet', async () => {
    const f = await fixture();
    f.execute.mockImplementationOnce(async () => {
      throw new Error('remote write completed before the response disconnected');
    });
    const initial = await f.service.invoke(request(), new AbortController().signal);
    expect(initial.status).toBe('verification_pending');

    const unavailable = new CapabilityService({
      store: f.store,
      executorRegistry: new CapabilityExecutorRegistry({}),
      getTemplate: (id, version) => (id === template.id && version === 1 ? template : undefined),
      getConnection: (id) => (id === f.connection.id ? f.connection : undefined),
      listConnections: () => [f.connection],
      isConnectionActiveForConversation: () => true,
      approve: f.approve,
    });
    const [recovered] = await unavailable.recoverPending(new AbortController().signal);
    expect(recovered).toMatchObject({ id: initial.id, status: 'verification_pending' });
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.store.get(initial.id)).toMatchObject({ status: 'verification_pending' });
  });

  it('settles concurrent reconnect recovery without turning one success into a failure', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.execute.mockImplementationOnce(async () => {
      controller.abort();
      return { output: { ok: true }, externalResultId: 'external-1' };
    });
    await f.service.invoke(request(), controller.signal);
    const [first, second] = await Promise.all([
      f.service.recoverPending(new AbortController().signal),
      f.service.recoverPending(new AbortController().signal),
    ]);
    expect(first[0]).toMatchObject({ status: 'succeeded' });
    expect(second[0]).toMatchObject({ status: 'succeeded' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('uses a trusted direct conversation binding instead of tool-supplied account identity', async () => {
    const f = await fixture();
    const direct = bindCapabilityExecution(f.service, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
    });
    const {
      accountId: ignoredAccount,
      conversationId: ignoredConversation,
      ...directRequest
    } = request({ idempotencyKey: 'direct-1' });
    expect(ignoredAccount).toBe('account-1');
    expect(ignoredConversation).toBe('conversation-1');
    const operation = await direct(directRequest, new AbortController().signal);
    expect(operation).toMatchObject({ accountId: 'account-1', conversationId: 'conversation-1' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('allows the same account and conversation to read durable history after live access closes', async () => {
    const f = await fixture();
    const operation = await f.service.invoke(request(), new AbortController().signal);
    f.setActive(false);
    expect(f.service.getOperation(operation.id, 'account-1', 'conversation-1')).toMatchObject({
      id: operation.id,
      status: 'succeeded',
    });
    await expect(
      f.service.invoke(request({ idempotencyKey: 'closed' }), new AbortController().signal),
    ).rejects.toThrow('unavailable');
  });

  it('keeps approval identity fields immutable when an input uses confusing keys', () => {
    expect(
      capabilityApprovalPayload({
        capabilityId: template.id,
        capabilityVersion: 1,
        connectionId: 'trusted-connection',
        operationId: 'trusted-operation',
        input: {
          connectionId: 'model-selected-connection',
          operationId: 'model-selected-operation',
        },
        forcePrompt: true,
      }),
    ).toMatchObject({
      input: {
        connectionId: 'model-selected-connection',
        operationId: 'model-selected-operation',
      },
      capabilityId: template.id,
      capabilityVersion: 1,
      connectionId: 'trusted-connection',
      operationId: 'trusted-operation',
    });
    expect(
      capabilityApprovalPayload({
        capabilityId: template.id,
        capabilityVersion: 1,
        connectionId: 'trusted-connection',
        operationId: 'trusted-operation',
        input: { value: 'hello' },
        forcePrompt: true,
      }).inputSha256,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('shows every byte of a valid bounded PR body in the approval payload', () => {
    const body = `${'x'.repeat(480)}\nchanged-actionable-suffix`;
    const payload = capabilityApprovalPayload({
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      connectionId: 'trusted-connection',
      operationId: 'trusted-operation',
      input: {
        repositoryPath: '/repo',
        baseBranch: 'main',
        title: 'Publish the reviewed change',
        body,
        draft: false,
      },
      forcePrompt: true,
    });
    expect(JSON.stringify(payload).length).toBeLessThan(10_000);
    expect(payload.input).toMatchObject({ body });
    expect(JSON.stringify(payload.input)).toContain('changed-actionable-suffix');
    expect(payload.inputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects oversized input rather than hiding fields or values from approval', () => {
    const input = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field-${index}`, 'x'.repeat(2_000)]),
    );
    expect(() =>
      capabilityApprovalPayload({
        capabilityId: 'wide-test',
        capabilityVersion: 1,
        connectionId: 'trusted-connection',
        operationId: 'trusted-operation',
        input,
        forcePrompt: true,
      }),
    ).toThrow('cannot fit a complete approval projection');
  });
});
