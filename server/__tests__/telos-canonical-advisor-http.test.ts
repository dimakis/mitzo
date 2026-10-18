import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { TelosWorkApiClient } from '@mitzo/client';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { createCanonicalAdvisorFixture } from './fixtures/telos-canonical-advisor.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

for (const variant of ['fresh', 'upgraded'] as const) {
  it.each(['refine', 'child'] as const)(
    `CT01: ${variant} advisor %s round-trips all canonical fields through HTTP and the typed client`,
    async (operation) => {
      const f = createCanonicalAdvisorFixture(variant, operation);
      cleanups.push(() => f.close());
      const app = express();
      app.use(express.json());
      app.use(
        createTelosWorkRouter({
          dbPath: () => f.dbPath,
          operatorAuth: (_req, res, next) => {
            res.locals.authSession = { id: f.actor.id, expiresAt: Date.now() + 60_000 };
            next();
          },
          verifyInternal: () => false,
          sessionId: () => undefined,
          ordinaryConversation: (id) => id === 'planning',
          advisorPreview: (req) => f.owner().preview(req.raw, req.actor),
          advisorSave: (req) => f.owner().save(req.raw, req.actor),
        }),
      );
      const api = new TelosWorkApiClient(async (url, init) => {
        const call = init?.method === 'POST' ? request(app).post(url) : request(app).get(url);
        for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
        if (init?.body) call.send(JSON.parse(String(init.body)));
        const result = await call;
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      const preview = await api.previewAdvisorDraft(f.input);
      const input = { ...f.input, previewSha256: preview.sha256 };
      const receipt = await api.saveAdvisorDraft(input);
      const record = await api.readRecord(receipt.work.itemId);
      const raw = f.db.prepare('SELECT * FROM items WHERE id=?').get(record.itemId) as Record<
        string,
        unknown
      >;
      expect(record).toMatchObject({
        itemId: receipt.work.itemId,
        summary: input.proposed.name,
        intent: input.proposed.desiredOutcome,
        parentId: operation === 'child' ? 'studio' : null,
        profile: 'manual',
        categories: ['Music'],
        priority: operation === 'child' ? 5 : 8,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      });
      expect(record.legacyFields.item).toEqual(raw);
      expect(record.legacyFields.sources).toEqual(
        f.db.prepare('SELECT * FROM sources WHERE item_id=?').all(record.itemId),
      );
      expect(record.legacyFields.links).toEqual(
        f.db.prepare('SELECT * FROM links WHERE item_id=?').all(record.itemId),
      );
      expect(receipt.work.sources).toHaveLength(1);
      expect(receipt.work.assignments).toEqual([]);
      expect(receipt.work.attempts).toEqual([]);
      f.restartOwners();
      expect(await api.saveAdvisorDraft(input)).toEqual(receipt);
      await expect(
        api.saveAdvisorDraft({
          ...input,
          proposed: { ...input.proposed, name: 'Different proposal' },
        }),
      ).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(await api.readRecord(record.itemId)).toEqual(record);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
      // Optional diagnostic export contains synthetic rows only. CI runs every
      // assertion above without needing another repository or Python runtime.
      const requested = process.env.TELOS_CANONICAL_ROUNDTRIP_EXPORT;
      if (requested) {
        const output = resolve(requested);
        if (!output.startsWith(resolve('foundation-evidence') + sep))
          throw new Error('Synthetic canonical exports must stay in foundation-evidence');
        mkdirSync(output, { recursive: true });
        const name = `${variant}-${operation}`;
        await f.db.backup(join(output, `${name}.db`));
        writeFileSync(
          join(output, `${name}.json`),
          JSON.stringify({ variant, operation, record }, null, 2),
        );
      }
    },
  );
}
