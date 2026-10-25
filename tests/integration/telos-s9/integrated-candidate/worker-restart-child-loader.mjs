import {
  initialize as originalInitialize,
  resolve as originalResolve,
  load as originalLoad,
} from './restart-child-loader.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let root;
export function initialize(data) {
  root = data.root;
  originalInitialize(data);
}
export const resolve = originalResolve;
export async function load(url, context, next) {
  const entrypoint = pathToFileURL(join(root, 'server/mcp-entrypoint.ts')).href;
  if (url === entrypoint) {
    // Real MCP source, stdio and tools remain unchanged. As in the accepted S9
    // helper, resolve only the test source-mode TS loader outside task cwd.
    const actual = JSON.stringify(entrypoint + '?s9-worker-restart-actual');
    return {
      format: 'module',
      shortCircuit: true,
      source: `
      import {createRequire} from 'node:module';
      import process from 'node:process';
      import {resolveBundledMcpEntrypoint as actual} from ${actual};
      export * from ${actual};
      const loader = createRequire(import.meta.url).resolve('tsx');
      export function resolveBundledMcpEntrypoint(url,name) {
        const entry = actual(url,name);
        return {...entry,command:process.execPath,args:entry.args.map(arg=>arg==='tsx'?loader:arg)};
      }
    `,
    };
  }
  return originalLoad(url, context, next);
}
