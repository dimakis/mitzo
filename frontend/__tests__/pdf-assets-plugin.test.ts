import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { pdfAssetsPlugin } from '../pdf-assets-plugin.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pdf-assets-'));
  roots.push(root);
  for (const directory of ['build', 'cmaps', 'standard_fonts', 'wasm'])
    mkdirSync(join(root, directory));
  for (const [path, body] of [
    ['build/pdf.worker.min.mjs', 'worker'],
    ['cmaps/sample.bcmap', 'map'],
    ['standard_fonts/font.ttf', 'font'],
    ['wasm/decoder.wasm', 'wasm'],
  ])
    writeFileSync(join(root, path), body);
  return root;
}
it('emits the exact installed PDF assets under stable runtime URLs without a glob watcher', () => {
  const plugin = pdfAssetsPlugin(fixture());
  const emitted: Array<{ type: 'asset'; fileName: string; source: Buffer }> = [];
  plugin.buildStart.call({ emitFile: (asset) => emitted.push(asset) });
  expect(emitted.map((a) => a.fileName).sort()).toEqual([
    'pdfjs/cmaps/sample.bcmap',
    'pdfjs/pdf.worker.min.mjs',
    'pdfjs/standard_fonts/font.ttf',
    'pdfjs/wasm/decoder.wasm',
  ]);
});
it('serves development GET/HEAD assets with the correct MIME types and never escapes the fixed inventory', async () => {
  const app = express();
  const plugin = pdfAssetsPlugin(fixture());
  plugin.configureServer({ middlewares: app } as unknown as Parameters<
    typeof plugin.configureServer
  >[0]);
  expect((await request(app).get('/pdfjs/pdf.worker.min.mjs')).text).toBe('worker');
  expect((await request(app).get('/pdfjs/wasm/decoder.wasm')).headers['content-type']).toBe(
    'application/wasm',
  );
  expect((await request(app).head('/pdfjs/cmaps/sample.bcmap')).headers['content-length']).toBe(
    '3',
  );
  for (const path of [
    '/pdfjs/unknown',
    '/pdfjs/%2e%2e/package.json',
    '/pdfjs/%252e%252e/package.json',
  ])
    expect((await request(app).get(path)).status).toBe(404);
  expect((await request(app).post('/pdfjs/pdf.worker.min.mjs')).status).toBe(405);
});
