import { expect, it } from 'vitest';
import { deriveRetainedNativeImportClosure } from '../../scripts/lib/staging-native-import-closure.mjs';
const read = (files) => (path) => {
  if (!(path in files)) throw Error('missing ' + path);
  return files[path];
};
it('pins actual transitive native imports and excludes only the source-owned app fork boundary', () => {
  const files = {
    'dist/symposium-custodian-main.js': `import './host.js'; await import('./engine.js'); fork(new URL('./index.js', import.meta.url));`,
    'dist/host.js': `export {host} from './shared.js';`,
    'dist/engine.js': `import 'zod'; import {host} from './shared.js';`,
    'dist/shared.js': `export const host=1;`,
    'dist/index.js': `import './child-only-backend.js';`,
  };
  const result = deriveRetainedNativeImportClosure({ readModule: read(files) });
  expect(result.modules.map((r) => r.path)).toEqual([
    'dist/engine.js',
    'dist/host.js',
    'dist/shared.js',
    'dist/symposium-custodian-main.js',
  ]);
  expect(result.externalPackages).toEqual(['zod']);
  const changed = { ...files, 'dist/index.js': 'changed child backend' };
  expect(deriveRetainedNativeImportClosure({ readModule: read(changed) }).sha256).toBe(
    result.sha256,
  );
  changed['dist/shared.js'] = 'export const host=2;';
  expect(deriveRetainedNativeImportClosure({ readModule: read(changed) }).sha256).not.toBe(
    result.sha256,
  );
});
it('refuses computed imports, escaped modules, unknown executable asset URLs and a second app fork', () => {
  for (const body of [
    `await import(variable);`,
    `import '../../escape.js';`,
    `new URL(variable, import.meta.url);`,
    `fork(new URL('./index.js',import.meta.url));fork(new URL('./index.js',import.meta.url));`,
  ])
    expect(() =>
      deriveRetainedNativeImportClosure({
        readModule: read({ 'dist/symposium-custodian-main.js': body }),
      }),
    ).toThrow('closure');
});
