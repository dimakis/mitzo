import { describe, expect, it, vi } from 'vitest';
import {
  SealedPublicationAuthority,
  type PublicationCredentialHandle,
  type SealedPublicationScope,
} from '../symposium-sealed-publication-authority.js';
function fixture() {
  const scope: SealedPublicationScope = {
    operatorId: 'operator',
    sessionId: 'session',
    recordId: 'review',
    recordHash: 'a'.repeat(64),
    sealId: 'seal',
    sealHash: 'b'.repeat(64),
    repository: 'owner/repo',
    connectionId: 'write-connection',
    connectionRevision: 1,
    credentialGeneration: 'generation-1',
  };
  const principal = { host: 'github.com' as const, numericId: 42, login: 'selected-user' };
  let identity = { id: 42, login: 'selected-user', type: 'User' };
  let authenticated = true;
  const handle: PublicationCredentialHandle = {
    connectionId: scope.connectionId,
    revision: 1,
    generation: 'generation-1',
    assertCurrent: vi.fn(() => true as const),
    run: vi.fn(async () => ({ stdout: JSON.stringify(identity) })),
  };
  let current: PublicationCredentialHandle | null = handle;
  const artifact = vi.fn(async () => {});
  const authority = new SealedPublicationAuthority(':memory:', {
    assertOperator: (operator, session) => {
      if (!authenticated || operator !== 'operator' || session !== 'session')
        throw Error('unauthenticated');
      return true;
    },
    assertArtifact: artifact,
    resolveCredential: () => current,
  });
  const signal = new AbortController().signal;
  return {
    scope,
    principal,
    handle,
    authority,
    signal,
    artifact,
    setIdentity: (value: typeof identity) => {
      identity = value;
    },
    setCurrent: (value: PublicationCredentialHandle | null) => {
      current = value;
    },
    logout: () => {
      authenticated = false;
    },
  };
}
describe('sealed publication authority', () => {
  it('uses only explicit credential handle and fresh numeric identity, binds approval', async () => {
    const f = fixture();
    expect(await f.authority.preview(f.scope, f.signal)).toEqual(f.principal);
    const grant = await f.authority.grant(f.scope, f.principal, f.signal);
    const proof = await f.authority.require(grant.id, grant.bindingHash, f.signal);
    expect(proof.approval.publicationGithubId).toBe('42');
    expect(proof.approval.publicationCredentialGeneration).toBe('generation-1');
    expect(proof.approval.publicationBindingHash).toBe(grant.bindingHash);
    expect(f.handle.run).toHaveBeenCalledTimes(3);
    expect(f.handle.run).toHaveBeenCalledWith(
      'gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', '/user'],
      f.signal,
    );
    expect(proof.handle).toBe(f.handle);
    f.authority.close();
  });
  it('rejects same login transferred to a different numeric identity after approval', async () => {
    const f = fixture();
    const g = await f.authority.grant(f.scope, f.principal, f.signal);
    f.setIdentity({ id: 99, login: 'selected-user', type: 'User' });
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'principal changed',
    );
    f.authority.close();
  });
  it('rejects missing and rotated credentials instead of using ambient credentials', async () => {
    const f = fixture();
    const g = await f.authority.grant(f.scope, f.principal, f.signal);
    f.setCurrent(null);
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'credential unavailable',
    );
    f.setCurrent({ ...f.handle, generation: 'generation-2' });
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'credential unavailable',
    );
    f.authority.close();
  });
  it('rejects a credential replacement during the identity read', async () => {
    const f = fixture();
    vi.mocked(f.handle.run).mockImplementationOnce(async () => {
      f.setCurrent({ ...f.handle });
      return { stdout: JSON.stringify({ id: 42, login: 'selected-user', type: 'User' }) };
    });
    await expect(f.authority.grant(f.scope, f.principal, f.signal)).rejects.toThrow(
      'handle changed',
    );
    f.authority.close();
  });
  it('requires current authenticated operator and unchanged seal on reuse', async () => {
    const f = fixture();
    const g = await f.authority.grant(f.scope, f.principal, f.signal);
    f.artifact.mockRejectedValueOnce(Error('seal changed'));
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'seal changed',
    );
    f.logout();
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'unauthenticated',
    );
    f.authority.close();
  });
  it('revokes pending authority and cannot rebind an existing grant', async () => {
    const f = fixture();
    const g = await f.authority.grant(f.scope, f.principal, f.signal);
    await expect(f.authority.require(g.id, 'c'.repeat(64), f.signal)).rejects.toThrow(
      'selection changed',
    );
    expect(() => f.authority.revoke(g.id, 'other', 'session')).toThrow();
    f.authority.revoke(g.id, 'operator', 'session');
    await expect(f.authority.require(g.id, g.bindingHash, f.signal)).rejects.toThrow(
      'grant unavailable',
    );
    f.authority.close();
  });
  it('requires explicit expected principal and rejects non-user credentials', async () => {
    const f = fixture();
    await expect(
      f.authority.grant(f.scope, { ...f.principal, numericId: 99 }, f.signal),
    ).rejects.toThrow('principal changed');
    f.setIdentity({ id: 42, login: 'selected-user', type: 'Bot' });
    await expect(f.authority.preview(f.scope, f.signal)).rejects.toThrow();
    f.authority.close();
  });
});

import { createHash } from 'node:crypto';
import { guardSealedPublicationExecutor } from '../symposium-sealed-publication-authority.js';
import { canonicalJson } from '../connections/capabilities/input-validation.js';
import type {
  CapabilityExecutionContext,
  CapabilityExecutor,
} from '../connections/capabilities/types.js';
it('binds forced approval to exact grant and prevents dispatch after credential change', async () => {
  const f = fixture();
  const grant = await f.authority.grant(f.scope, f.principal, f.signal);
  const base: CapabilityExecutor = {
    preflight: vi.fn(async () => ({
      approvalInput: { title: 'Approved title' },
      recoveryIntent: { remote: 'read-key' },
    })),
    execute: vi.fn(async () => ({ output: { done: true } })),
    verify: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
  };
  const wrapper = guardSealedPublicationExecutor(
    f.authority,
    () => ({ grantId: grant.id, bindingHash: grant.bindingHash }),
    base,
  );
  const context = {
    operation: {
      id: 'op',
      connectionId: 'write-connection',
      connectionRevision: 1,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      grantId: 'capability-grant',
      accountId: 'operator-principal',
      conversationId: 'session',
      turnId: 'turn',
      idempotencyKey: 'key',
      inputHash: 'hash',
      status: 'verification_pending',
      externalResultId: null,
      result: null,
      failureCode: null,
      createdAt: 1,
      updatedAt: 1,
    },
    input: { title: 'Approved title' },
    signal: f.signal,
  } as CapabilityExecutionContext;
  const preflight = await wrapper.preflight!(context);
  context.operation.recoveryIntent = preflight.recoveryIntent;
  context.operation.approvalInput = preflight.approvalInput;
  context.operation.approvalHash = createHash('sha256')
    .update(canonicalJson(preflight.approvalInput))
    .digest('hex');
  context.approvalInput = preflight.approvalInput;
  await wrapper.execute(context);
  expect(base.execute).toHaveBeenCalledTimes(1);
  f.setCurrent({ ...f.handle, generation: 'rotated' });
  await expect(wrapper.execute(context)).rejects.toThrow('credential unavailable');
  expect(base.execute).toHaveBeenCalledTimes(1);
  f.authority.close();
});
it('rejects changed approved authority even with recomputed approval hash', async () => {
  const f = fixture();
  const grant = await f.authority.grant(f.scope, f.principal, f.signal);
  const execute = vi.fn(async () => ({ output: {} }));
  const wrapper = guardSealedPublicationExecutor(
    f.authority,
    () => ({ grantId: grant.id, bindingHash: grant.bindingHash }),
    {
      preflight: async () => ({
        approvalInput: { title: 'title' },
        recoveryIntent: { remote: 'key' },
      }),
      execute,
      verify: async () => {},
      recover: async () => {},
    },
  );
  const context = {
    operation: {
      id: 'op',
      connectionId: 'write-connection',
      connectionRevision: 1,
      capabilityId: 'github.publish-pr',
      capabilityVersion: 1,
      grantId: 'capability-grant',
      accountId: 'operator-principal',
      conversationId: 'session',
      turnId: 'turn',
      idempotencyKey: 'key',
      inputHash: 'hash',
      status: 'verification_pending',
      externalResultId: null,
      result: null,
      failureCode: null,
      createdAt: 1,
      updatedAt: 1,
    },
    input: { title: 'title' },
    signal: f.signal,
  } as CapabilityExecutionContext;
  const preflight = await wrapper.preflight!(context);
  const changed = { ...preflight.approvalInput, publicationGithubId: '99' };
  context.operation.recoveryIntent = preflight.recoveryIntent;
  context.operation.approvalInput = changed;
  context.approvalInput = changed;
  context.operation.approvalHash = createHash('sha256')
    .update(canonicalJson(changed))
    .digest('hex');
  await expect(wrapper.execute(context)).rejects.toThrow('authority changed');
  expect(execute).not.toHaveBeenCalled();
  f.authority.close();
});

it('rejects undefined or asynchronous custody acknowledgements', async () => {
  const f = fixture();
  vi.mocked(f.handle.assertCurrent).mockReturnValueOnce(undefined as never);
  await expect(f.authority.preview(f.scope, f.signal)).rejects.toThrow(
    'Current publication credential required',
  );
  vi.mocked(f.handle.assertCurrent).mockReturnValueOnce(Promise.resolve(true) as never);
  await expect(f.authority.preview(f.scope, f.signal)).rejects.toThrow(
    'Current publication credential required',
  );
  for (const acknowledgement of [undefined, Promise.resolve(true)]) {
    const authority = new SealedPublicationAuthority(':memory:', {
      assertOperator: () => acknowledgement as never,
      assertArtifact: async () => {},
      resolveCredential: () => f.handle,
    });
    await expect(authority.preview(f.scope, f.signal)).rejects.toThrow(
      'Authenticated publication operator required',
    );
    authority.close();
  }
  f.authority.close();
});

import { mkdtempSync, chmodSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('requires private owned database and parent modes', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-grants-')));
  const deps = {
    assertOperator: () => true as const,
    assertArtifact: async () => {},
    resolveCredential: () => null,
  };
  try {
    chmodSync(directory, 0o755);
    expect(() => new SealedPublicationAuthority(join(directory, 'grants.db'), deps)).toThrow(
      'Private publication grant directory',
    );
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, 'grants.db'), '');
    chmodSync(join(directory, 'grants.db'), 0o644);
    expect(() => new SealedPublicationAuthority(join(directory, 'grants.db'), deps)).toThrow(
      'Private publication grant database',
    );
    chmodSync(join(directory, 'grants.db'), 0o600);
    new SealedPublicationAuthority(join(directory, 'grants.db'), deps).close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('verifies recovery with a fresh observer without reviving the original grant operator', async () => {
  let oldActive = true;
  const active = new Set(['fresh']);
  const f = fixture();
  const authority = new SealedPublicationAuthority(':memory:', {
    assertOperator(id) {
      if (id === 'operator' ? oldActive : active.has(id)) return true;
      throw Error('expired');
    },
    assertArtifact: async () => {},
    resolveCredential: () => f.handle,
  });
  const grant = await authority.grant(f.scope, f.principal, f.signal);
  oldActive = false;
  try {
    await expect(authority.require(grant.id, grant.bindingHash, f.signal)).rejects.toThrow(
      'expired',
    );
    const proof = await authority.requireRecovery(
      grant.id,
      grant.bindingHash,
      'fresh',
      f.handle,
      f.signal,
    );
    expect(proof.grant).toEqual(grant);
    expect(proof.handle).toBe(f.handle);
    await expect(authority.require(grant.id, grant.bindingHash, f.signal)).rejects.toThrow(
      'expired',
    );
    active.clear();
    await expect(
      authority.requireRecovery(grant.id, grant.bindingHash, 'fresh', f.handle, f.signal),
    ).rejects.toThrow('unavailable');
  } finally {
    authority.close();
    f.authority.close();
  }
});
