import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Optional CI evidence only; does not add, transform or replace frontend assets. */
export function productionBundleEvidence(): Plugin[] {
  const directory = process.env.MITZO_BUILD_EVIDENCE_DIR;
  if (!directory) return [];
  if (!isAbsolute(directory)) throw new Error('Build evidence directory must be absolute');
  let root: string;
  return [
    {
      name: 'retain-production-bundle-inputs',
      configResolved(config) {
        root = resolve(config.root, '..');
      },
      generateBundle() {
        const files = new Set<string>([
          'package.json',
          'package-lock.json',
          'frontend/package.json',
          'frontend/index.html',
          'frontend/tsconfig.json',
          'frontend/vite.config.ts',
          'frontend/production-bundle-evidence.ts',
        ]);
        const virtualModules: Record<string, string> = {};
        for (const id of this.getModuleIds()) {
          const path = id.split('?')[0];
          if (isAbsolute(path) && existsSync(path) && statSync(path).isFile())
            files.add(relative(root, path));
          else {
            const code = this.getModuleInfo(id)?.code;
            if (code !== undefined && code !== null)
              virtualModules[id] = createHash('sha256').update(code).digest('hex');
          }
        }
        const inputs = Object.fromEntries(
          [...files].sort().map((path) => [
            path,
            createHash('sha256')
              .update(readFileSync(resolve(root, path)))
              .digest('hex'),
          ]),
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          resolve(directory, 'inputs.json'),
          JSON.stringify({ inputs, virtualModules }, null, 2) + '\n',
        );
      },
    },
  ];
}
