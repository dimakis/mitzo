import { readFile, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

type Asset = { type: 'asset'; fileName: string; source: Buffer };
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
/** Installed PDF assets are a fixed inventory, not user-supplied glob patterns.
 * Vite owns the development watcher; these immutable dependencies need none. */
export function pdfAssetsPlugin(
  directory = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
) {
  const assets = new Map<string, string>();
  assets.set('/pdfjs/pdf.worker.min.mjs', join(directory, 'build/pdf.worker.min.mjs'));
  function collect(relative: string) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) assets.set(`/pdfjs/${path}`, join(directory, path));
      else throw new Error('PDF asset inventory must contain regular files');
    }
  }
  for (const relative of ['cmaps', 'standard_fonts', 'wasm']) collect(relative);
  return {
    name: 'mitzo-pdf-assets',
    buildStart(this: { emitFile(asset: Asset): unknown }) {
      for (const [url, path] of assets)
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(path) });
    },
    configureServer(server: { middlewares: { use(handler: Middleware): unknown } }) {
      server.middlewares.use((req, res, next) => {
        let path: string;
        try {
          path = decodeURIComponent(new URL(req.url ?? '', 'http://pdf-assets.invalid').pathname);
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        if (!path.startsWith('/pdfjs/')) return next();
        const file = assets.get(path);
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (!['GET', 'HEAD'].includes(req.method ?? '')) {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end();
          return;
        }
        readFile(file, (error, body) => {
          if (error) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const mime = path.endsWith('.mjs')
            ? 'text/javascript'
            : path.endsWith('.wasm')
              ? 'application/wasm'
              : path.endsWith('.ttf')
                ? 'font/ttf'
                : 'application/octet-stream';
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', body.length);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(req.method === 'HEAD' ? undefined : body);
        });
      });
    },
  } satisfies Plugin;
}
