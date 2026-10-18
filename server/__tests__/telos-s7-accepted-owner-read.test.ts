import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkApiClient } from '@mitzo/client';
import { createTelosWorkRouter } from '../telos-work-routes';
import { closeTestServer, listenOnLoopback } from './loopback-test-server';

const fixtures = new URL('./fixtures/telos-s7-accepted-owner/', import.meta.url);
const manifestBytes = readFileSync(new URL('manifest.json', fixtures));
const manifest = JSON.parse(manifestBytes.toString('utf8'));

// This is the S7 read boundary against accepted owner DDL, not a second canonical
// creator/migrator or proof of advisor save/role admission. All rows are synthetic.
for (const schema of ['fresh', 'upgraded'] as const)
  it(`reads original fields, categories and all persisted priorities from accepted ${schema} owner schema`, async () => {
    expect(manifest.owner.revision).toBe('3077b7b4dcdf0ef097062794b2ab93d33c1d89ad');
    expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(
      '772a4cc853bf7a6617f4a5eedd5228c2d35679c37298908075460a79b94c8158',
    );
    expect(manifest.defaultDatabaseUntouched).toBe(true);
    const sql = readFileSync(new URL(schema + '.sql', fixtures), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe(manifest.schemas[schema]);
    const root = mkdtempSync(join(tmpdir(), 's7-accepted-owner-'));
    const path = join(root, 'synthetic.db');
    const db = new Database(path);
    db.pragma('foreign_keys = OFF');
    db.exec(sql);
    db.pragma('foreign_keys = ON');
    const id = 's7-accepted-record';
    const original = '2025-01-02T03:04:05+01:00';
    const categories = ['Personal projects', 'Recording'];
    db.prepare(
      `INSERT INTO items(id,summary,intent,rationale,profile,categories,priority,first_seen,last_seen,created_at,updated_at)
      VALUES(?,?,?,?,?,?,3,?,?,?,?)`,
    ).run(
      id,
      'Home studio setup',
      'Record clear audio',
      'Finish a personal project',
      'manual',
      JSON.stringify(categories),
      original,
      original,
      original,
      original,
    );
    db.prepare(
      `INSERT INTO sources(id,item_id,type,source_id,url,title,author,timestamp,raw_snippet)
      VALUES('original',?,'external_codex','planning','codex://threads/planning','Planning exchange','Operator',?,'Original exchange retained in full.')`,
    ).run(id, original);
    const app = express();
    app.use(
      createTelosWorkRouter({
        dbPath: () => path,
        operatorAuth: (req, res, next) => {
          if (req.headers['x-synthetic-operator'] !== 'yes') {
            res.status(403).end();
            return;
          }
          res.locals.authSession = { id: 'synthetic-s7', expiresAt: Date.now() + 60_000 };
          next();
        },
        verifyInternal: () => false,
        sessionId: () => undefined,
        ordinaryConversation: () => false,
      }),
    );
    const server = await listenOnLoopback(app);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Synthetic listener unavailable');
      const api = new TelosWorkApiClient(async (url, init) => {
        const response = await fetch(`http://127.0.0.1:${address.port}` + url, {
          ...init,
          headers: { 'x-synthetic-operator': 'yes' },
        });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        return response;
      });
      for (let priority = 1; priority <= 10; priority++) {
        // Simulate a canonical-owner write; S7 introduces no write implementation.
        db.prepare('UPDATE items SET priority=? WHERE id=?').run(priority, id);
        const record = await api.readRecord(id);
        expect(record).toMatchObject({
          itemId: id,
          priority,
          categories,
          kind: null,
          parentId: null,
          createdAt: original,
        });
        expect(record.sources[0].rawSnippet).toBe('Original exchange retained in full.');
      }
      db.prepare('UPDATE items SET summary=?,categories=? WHERE id=?').run(
        'Refined original identity',
        JSON.stringify(['Recording', 'Reviewed']),
        id,
      );
      expect(await api.readRecord(id)).toMatchObject({
        itemId: id,
        summary: 'Refined original identity',
        categories: ['Recording', 'Reviewed'],
      });
      expect(db.prepare('SELECT first_seen,created_at FROM items WHERE id=?').get(id)).toEqual({
        first_seen: original,
        created_at: original,
      });
    } finally {
      server.closeAllConnections();
      await closeTestServer(server);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
