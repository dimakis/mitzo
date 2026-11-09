import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { createDeploymentRuntime } from '../deployment-runtime.js';
const f = vi.hoisted(() => ({ cold: false, primary: true }));
vi.mock('../auth.js', () => ({
  hasPersistentRevocationAuthority: () => true,
  isAuthSessionCurrent: () => true,
  isAuthenticatedOperatorSessionId: () => f.primary,
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: () => undefined,
  getCodexConversationStore: () => ({
    hasRunningCommands: () => false,
    runningConversationIds: () => [],
    deploymentRecoveryPending: () => f.cold,
    subagents: { unsettledConversationIds: () => [] },
  }),
}));
vi.mock('../session-prompt-dispatch.js', () => ({
  createSessionPromptPort: () => ({ close() {} }),
}));
vi.mock('../ordinary-contributor-execution.js', () => ({
  assertOrdinaryContributorControlAllowed() {},
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
  f.cold = false;
  f.primary = true;
});
function fixture() {
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  const registry = { getActiveSessions: () => [] };
  const runtime = createDeploymentRuntime(
    { eventStore: events, sessionRegistry: registry } as unknown as Parameters<
      typeof createDeploymentRuntime
    >[0],
    {
      commit: () => 'a'.repeat(40),
      healthy: () => true,
      backgroundIdle: () => true,
      authorizeSession() {},
    },
  );
  cleanups.push(runtime.close);
  const auth = { id: 'signed-operator', expiresAt: Date.now() + 60_000 };
  return { events, coordinator: runtime.coordinator, auth };
}
it('blocks a delayed pre-registry bootstrap and its durable uncertain admission', async () => {
  const f = fixture();
  const release = f.events.reserveOrdinaryStartup(['bootstrapping']);
  expect(f.events.deploymentStartupPending()).toBe(true);
  expect(() => f.coordinator.begin('deployment', 'b'.repeat(40), f.auth)).toThrow(/startup/);
  release();
  expect(f.events.deploymentStartupPending()).toBe(false);
  expect(f.coordinator.begin('deployment', 'b'.repeat(40), f.auth).phase).toBe('pausing');
  expect((await f.coordinator.pause('deployment', f.auth)).phase).toBe('paused');
});
it('blocks cold parent effects even with empty registry and no running commands', () => {
  const runtime = fixture();
  f.cold = true;
  expect(() => runtime.coordinator.begin('deployment', 'b'.repeat(40), runtime.auth)).toThrow(
    /Retained parent/,
  );
  expect(runtime.events.deployment.active()?.phase).toBe('capturing');
});

it('requires primary interactive operator authority for the global deployment hold', () => {
  const runtime = fixture();
  f.primary = false;
  expect(() => runtime.coordinator.begin('deployment', 'b'.repeat(40), runtime.auth)).toThrow(
    /signed deployment operator/,
  );
  expect(runtime.events.deployment.active()).toBeUndefined();
});
