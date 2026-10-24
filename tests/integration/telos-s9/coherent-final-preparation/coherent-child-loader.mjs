import {
  resolve as originalResolve,
  load,
  initialize as originalInitialize,
} from './worker-restart-child-loader.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let root;
export function initialize(data) {
  root = data.root;
  originalInitialize(data);
}
export { load };
export function resolve(specifier, context, next) {
  if (specifier === '@mitzo/protocol/telos-sqlite-owners')
    return next(
      pathToFileURL(join(root, 'packages/protocol/src/telos-sqlite-owners.ts')).href,
      context,
    );
  return originalResolve(specifier, context, next);
}
