import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login, authMiddleware } from '../auth.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationCenter } from '../notification-center.js';
import { UnifiedInbox } from '../unified-inbox.js';
import { unifiedInboxRouter } from '../unified-inbox-routes.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});

it.each(['/feed?view=all', '/records/inbox%3Aone.md'])(
  'refreshes sources once for %s without computing a discarded notification feed',
  async (path) => {
    const root = mkdtempSync(join(tmpdir(), 'offline-inbox-route-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new NotificationStore(':memory:');
    cleanup.push(() => store.close());
    const center = new NotificationCenter(store, {
      push: vi.fn(async () => ({ status: 'unavailable' as const, acceptedDevices: [] })),
      changed: vi.fn(),
      configured: () => false,
      devices: () => 0,
      sessionTitle: () => undefined,
    });
    cleanup.push(() => center.close());
    const app = express();
    app.use(authMiddleware);
    app.use(
      '/api/inbox',
      unifiedInboxRouter(center, () => root),
    );
    const token = await login(process.env.AUTH_PASSPHRASE!);
    const scan = vi.spyOn(UnifiedInbox.prototype, 'reconcile');
    const discardedFeed = vi.spyOn(store, 'feed');
    const permissions = vi.spyOn(store, 'reconcilePermissions');
    for (const text of ['Original source', 'Changed source']) {
      writeFileSync(join(root, 'one.md'), '# ' + text);
      scan.mockClear();
      permissions.mockClear();
      const response = await request(app)
        .get('/api/inbox' + path)
        .set('Authorization', 'Bearer ' + token);
      expect(response.status).toBe(200);
      const item = path.startsWith('/feed') ? response.body.items[0] : response.body;
      expect(item.title).toContain(text);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(permissions).toHaveBeenCalledTimes(1);
      expect(discardedFeed).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toBe('no-store');
    }
  },
);
