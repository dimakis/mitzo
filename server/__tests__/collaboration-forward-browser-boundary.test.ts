import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const alias = {
  '@mitzo/client/hooks': resolve(root, 'packages/client/src/hooks/index.ts'),
  '@mitzo/client': resolve(root, 'packages/client/src/index.ts'),
  '@mitzo/protocol': resolve(root, 'packages/protocol/src/index.ts'),
};

it.each(['public packages', 'approved chat', 'shared conversation'] as const)(
  'awaits the actual %s browser bundle without Node custody imports',
  async (entry) => {
    const result = await build({
      ...(entry === 'public packages'
        ? {
            stdin: {
              contents:
                "export * from '@mitzo/protocol'; export { CollaborationApiClient } from '@mitzo/client';",
              resolveDir: root,
              sourcefile: 'public-browser-entry.ts',
              loader: 'ts' as const,
            },
          }
        : {
            entryPoints: [
              resolve(
                root,
                entry === 'approved chat'
                  ? 'frontend/src/preview/main.tsx'
                  : 'tests/fixtures/symposium-shared-conversation.tsx',
              ),
            ],
          }),
      absWorkingDir: root,
      platform: 'browser',
      bundle: true,
      write: false,
      outfile: '/tmp/mitzo-forward-browser-boundary.js',
      jsx: 'automatic',
      minify: true,
      external: ['/*.png', '/*.svg'],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      alias,
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.outputFiles.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.metafile.inputs)).toContain('packages/protocol/src/index.ts');
    expect(
      Object.keys(result.metafile.inputs).some((path) =>
        path.includes('collaboration-forward-custody'),
      ),
    ).toBe(false);
    expect(
      Object.values(result.metafile.inputs)
        .flatMap((input) => input.imports)
        .some((imported) => imported.path.startsWith('node:')),
    ).toBe(false);
  },
);
