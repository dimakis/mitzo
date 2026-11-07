import { afterEach } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionCapabilityGrants } from '../../session-capability-grants.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
export function capabilityFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-session-capabilities-')));
  const registry = new SessionRegistry();
  cleanups.push(() => {
    registry.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const sent: Record<string, unknown>[] = [];
  for (const id of ['one', 'two', 'foreign']) {
    const cwd = join(root, id);
    mkdirSync(cwd);
    registry.register(id, {
      sessionId: id,
      cwd,
      mode: 'agent',
      ownedLocalAuthSessionId: id === 'foreign' ? 'other' : 'operator',
      accountBinding: {
        accountId: 'a',
        accountLabel: 'Offline account',
        provider: 'openai-codex',
        profileRevision: 'v1',
        model: 'm',
      },
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      transport: {
        send(message) {
          sent.push(message);
        },
        isOpen: () => true,
      },
    });
  }
  return {
    root,
    registry,
    sent,
    session: registry.get('one')!,
    grants: new SessionCapabilityGrants(registry),
  };
}
