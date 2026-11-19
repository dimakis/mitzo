import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { ClaudeSubscriptionCustody } from '../claude-subscription-custody.js';
import { OrdinaryLocalWorkspaceOwner } from '../ordinary-local-workspace-owner.js';
import { runtimeFailureDiagnostics } from '../runtime-failure-diagnostics.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
beforeEach(resetOfflineUserEnvironment);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('preserves the ownership fence when source cleanup races Personal Claude input authorization', async () => {
  const capture = ClaudeSubscriptionCustody.capture;
  vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
    capture(env, join(dirname(env.CLAUDE_CONFIG_DIR!), 'claude-fixture')),
  );
  vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
  const f = await ownedVertexRuntimeFixture(cleanups, {
    personal: true,
    ordinaryPreparation: true,
    localRepository: true,
    chatRoute: true,
  });
  await f.workspace.claimReservedHostTask({ ...f.reservation, signal: f.signal.signal });
  vi.mocked(ClaudeSubscriptionCustody.prototype.verify).mockImplementationOnce(async () => {
    await f.workspace.releaseSource(
      f.reservation.id,
      f.reservation.binding,
      f.reservation.conversationId,
    );
  });
  const owner = new OrdinaryLocalWorkspaceOwner(f.workspace, 'repository', f.reservation);
  const result = owner.revalidate(f.signal.signal);
  await expect(result).rejects.toThrow('Host repository ownership changed during authorization');
  await result.catch((error: unknown) => {
    expect(runtimeFailureDiagnostics(error)).toMatchObject({
      failedCheck: 'host_reservation.authorize',
      authorityChecks: ['workspace.reserve', 'host_reservation.authorize'],
    });
  });
  await expect(owner.revalidate(f.signal.signal)).resolves.toBeUndefined();
});
