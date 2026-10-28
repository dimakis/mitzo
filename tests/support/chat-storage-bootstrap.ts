import type { Plugin } from 'esbuild';
import { resolve } from 'node:path';

/** Mirror main.tsx: hydrate durable chat state before evaluating fixture modules.
 * A deferred import also works for fixtures bundled as classic scripts.
 */
export function chatStorageBootstrap(): Plugin {
  return {
    name: 'chat-storage-bootstrap',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== 'entry-point') return;
        return { path: resolve(args.resolveDir, args.path), namespace: 'chat-storage-bootstrap' };
      });
      build.onLoad({ filter: /.*/, namespace: 'chat-storage-bootstrap' }, (args) => ({
        contents: `import { initializeChatStorage } from ${JSON.stringify(resolve('frontend/src/lib/large-chat-storage.ts'))};
void initializeChatStorage().then(() => import(${JSON.stringify(args.path)}));`,
        loader: 'ts',
        resolveDir: process.cwd(),
      }));
    },
  };
}
