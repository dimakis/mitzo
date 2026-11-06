import { afterEach, expect, it } from 'vitest';
import { onPermissionAudit, type PermissionAuditEvent } from '../src/permission-audit.js';
import { registerPending, removePending, resolvePending } from '../src/permissions.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture() {
  const events: PermissionAuditEvent[] = [];
  cleanup.push(onPermissionAudit((event) => events.push(event)));
  const register = () =>
    registerPending(
      'audit-perm',
      'Bash',
      (result) => result,
      { command: 'echo secret-value' },
      'elevated',
      'session',
      {
        permId: 'audit-perm',
        sessionId: 'session',
        toolName: 'Bash',
        toolInput: 'echo secret-value',
        approvalScope: 'session',
        expiresAt: Date.now() + 60000,
      },
      undefined,
      { toolUseID: 'call', scopeHash: 'scope-hash' },
    );
  cleanup.push(() => removePending('audit-perm'));
  return { events, register };
}
it('records requests and the final applied decision without retaining command or question bodies', () => {
  const { events, register } = fixture();
  register();
  expect(resolvePending('audit-perm', 'always', undefined, 'session')).toBe(true);
  expect(events).toMatchObject([
    {
      phase: 'requested',
      permId: 'audit-perm',
      sessionId: 'session',
      toolName: 'Bash',
      toolUseID: 'call',
    },
    {
      phase: 'resolved',
      permId: 'audit-perm',
      decision: 'always',
      outcome: 'allowed',
      approvalScope: 'session',
      scopeHash: 'scope-hash',
    },
  ]);
  expect(JSON.stringify(events)).not.toContain('secret-value');
  expect(events[1].waitMs).toBeGreaterThanOrEqual(0);
});
it('distinguishes cancellation from expiry and never records a stale response as approval', () => {
  const { events, register } = fixture();
  register();
  removePending('audit-perm', 'cancelled');
  expect(resolvePending('audit-perm', 'once', undefined, 'session')).toBe(false);
  expect(events.at(-1)).toMatchObject({ phase: 'resolved', outcome: 'cancelled' });
});
it('records a resolver policy refusal as denied even if the operator selected always', () => {
  const { events } = fixture();
  registerPending(
    'audit-perm',
    'Bash',
    () => ({ behavior: 'deny', message: 'Scope changed' }),
    {},
    'elevated',
    'session',
    { permId: 'audit-perm', toolName: 'Bash', toolInput: '{}', sessionId: 'session' },
  );
  resolvePending('audit-perm', 'always', undefined, 'session');
  expect(events.at(-1)).toMatchObject({ outcome: 'denied', decision: 'always' });
});
it('records resolver failure explicitly instead of inventing an allow receipt', () => {
  const { events } = fixture();
  registerPending(
    'audit-perm',
    'Bash',
    () => {
      throw Error('resolver failed');
    },
    {},
    'elevated',
    'session',
  );
  expect(() => resolvePending('audit-perm', 'always', undefined, 'session')).toThrow(
    'resolver failed',
  );
  expect(events.at(-1)).toMatchObject({ phase: 'resolved', outcome: 'failed', decision: 'always' });
});
