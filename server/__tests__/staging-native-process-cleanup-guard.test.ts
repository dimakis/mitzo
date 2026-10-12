import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe('original controlled process cleanup queue guard', () => {
  it('retains original cleanup authority after new resource admission closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-process-cleanup-'));
    roots.push(root);
    let resourcesAvailable = true;
    const confirm = vi.fn().mockResolvedValue(undefined),
      cleanup = vi.fn();
    const registry = new SymposiumAttemptRegistry(join(root, 'claims.db'), {
      launch: () => ({ child: {} as ChildProcessWithoutNullStreams, confirmStopped: confirm }),
      confirm: vi.fn().mockRejectedValue(Error('not original proof')),
    });
    const process = registry.launch({
      sessionId: 'stage',
      claimToken: 'claim',
      sandbox: {
        sandboxName: 'stage-sandbox',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'stage-gateway',
        workspace: 'stage-workspace',
        gatewayInsecure: false,
      },
      access: 'read',
      command: ['/fixture-controller'],
      assertOriginalEffectCurrent: () => {
        if (!resourcesAvailable) throw Error('resource pressure');
      },
      assertOriginalCleanupCurrent: cleanup,
    });
    resourcesAvailable = false;
    await process.confirmStopped();
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(registry.readOriginalStopReceipt('claim').sessionId).toBe('stage');
    registry.close();
  });
  it.each(['before', 'after'] as const)(
    'retains uncertainty when the original queue is lost %s actual confirmation',
    async (boundary) => {
      const root = mkdtempSync(join(tmpdir(), 'stage-process-guard-'));
      roots.push(root);
      let current = true;
      const confirm = vi.fn(async () => {
        current = false;
      });
      const fence = vi.fn(() => {
        if (!current) throw Error('original queue lost');
      });
      const registry = new SymposiumAttemptRegistry(join(root, 'claims.db'), {
        launch: () => ({ child: {} as ChildProcessWithoutNullStreams, confirmStopped: confirm }),
        confirm: vi.fn().mockRejectedValue(Error('durable recovery is not original proof')),
      });
      const process = registry.launch({
        sessionId: 'stage',
        claimToken: 'claim',
        sandbox: {
          sandboxName: 'stage-sandbox',
          workdir: '/sandbox/workspaces/mgmt',
          cli: 'openshell',
          gateway: 'stage-gateway',
          workspace: 'stage-workspace',
          gatewayInsecure: false,
        },
        access: 'read',
        command: ['/fixture-controller'],
        assertOriginalEffectCurrent: fence,
      });
      if (boundary === 'before') current = false;
      await expect(process.confirmStopped()).rejects.toThrow();
      expect(confirm).toHaveBeenCalledTimes(boundary === 'before' ? 0 : 1);
      expect(registry.get('claim')?.state).toBe('uncertain');
      expect(() => registry.readOriginalStopReceipt('claim')).toThrow(/receipt/);
      await expect(process.confirmStopped()).rejects.toThrow();
      expect(confirm).toHaveBeenCalledTimes(boundary === 'before' ? 0 : 1);
      registry.close();
    },
  );
});
