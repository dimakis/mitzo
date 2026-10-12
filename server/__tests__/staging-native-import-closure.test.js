import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
    `fork(variable);`,
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
it('pins retained child-control code while excluding only its mutually exclusive accepted app fork', () => {
  const files = {
    'dist/symposium-custodian-main.js': `import './symposium-original-app-child-update.js';const child=appChildControl ? fork(resolve(selectedRoot, 'dist/index.js'),[],{}) : fork(new URL('./index.js',import.meta.url),[],{});`,
    'dist/symposium-original-app-child-update.js': `export const originalControl=1;`,
    'dist/index.js': `import './ordinary-only.js';`,
  };
  const first = deriveRetainedNativeImportClosure({ readModule: read(files) });
  expect(first.modules.map((x) => x.path)).toEqual([
    'dist/symposium-custodian-main.js',
    'dist/symposium-original-app-child-update.js',
  ]);
  expect(
    deriveRetainedNativeImportClosure({
      readModule: read({ ...files, 'dist/index.js': 'different ordinary backend' }),
    }).sha256,
  ).toBe(first.sha256);
  expect(
    deriveRetainedNativeImportClosure({
      readModule: read({
        ...files,
        'dist/symposium-original-app-child-update.js': 'export const originalControl=2;',
      }),
    }).sha256,
  ).not.toBe(first.sha256);
  for (const body of [
    `fork(resolve(selectedRoot, 'dist/index.js'));`,
    `appChildControl ? fork(resolve(selectedRoot, 'dist/other.js')) : fork(new URL('./index.js',import.meta.url));`,
    `unrelatedFlag ? fork(resolve(selectedRoot, 'dist/index.js')) : fork(new URL('./index.js',import.meta.url));`,
  ])
    expect(() =>
      deriveRetainedNativeImportClosure({
        readModule: read({ ...files, 'dist/symposium-custodian-main.js': body }),
      }),
    ).toThrow('closure');
});
it('pins actual tracked native data/helper assets without treating their bytes as JavaScript', () => {
  const files = {
    'dist/symposium-custodian-main.js': `import './host.js';fork(new URL('./index.js',import.meta.url));`,
    'dist/host.js': `new URL('../server/helper.py',import.meta.url);new URL('../content/quotes/catalog.json',import.meta.url);`,
    'server/helper.py': 'import json\n',
    'content/quotes/catalog.json': '{"quotes":[]}',
  };
  const first = deriveRetainedNativeImportClosure({ readModule: read(files) });
  expect(first.modules.map((x) => x.path)).toContain('server/helper.py');
  expect(
    deriveRetainedNativeImportClosure({
      readModule: read({ ...files, 'server/helper.py': 'import sys\n' }),
    }).sha256,
  ).not.toBe(first.sha256);
  expect(() =>
    deriveRetainedNativeImportClosure({
      readModule: read({
        ...files,
        'dist/host.js': `new URL('../../escape/config.json',import.meta.url);`,
      }),
    }),
  ).toThrow();
});
it('resolves only the actual retained provider function finite literal pin map and refuses computed or added map inputs', () => {
  const body = `export function reviewedRuntimeProfile(type){const pins={'profile':['../infra/openshell/providers/profile.json','${createHash('sha256').update('{}').digest('hex')}']};const pin=pins[type];if(!pin)throw Error();const path=new URL(pin[0],import.meta.url);}`;
  const files = {
    'dist/symposium-custodian-main.js': `import './openshell-runtime-policy.js';fork(new URL('./index.js',import.meta.url));`,
    'dist/openshell-runtime-policy.js': body,
    'infra/openshell/providers/profile.json': '{}',
  };
  expect(
    deriveRetainedNativeImportClosure({ readModule: read(files) }).modules.map((x) => x.path),
  ).toContain('infra/openshell/providers/profile.json');
  expect(() =>
    deriveRetainedNativeImportClosure({
      readModule: read({
        ...files,
        'infra/openshell/providers/profile.json': '{"changed":true}',
      }),
    }),
  ).toThrow('literal pin');
  for (const changed of [
    body.replace('pins[type]', 'other[type]'),
    body.replace("'../infra/openshell/providers/profile.json'", 'externalPath'),
  ])
    expect(() =>
      deriveRetainedNativeImportClosure({
        readModule: read({ ...files, 'dist/openshell-runtime-policy.js': changed }),
      }),
    ).toThrow();
});
