import type { AuthorizedContextPacks } from './agent-context-compiler.js';
import type { AcceptedKnowledgeSource } from './knowledge-library-source.js';
import type { ContextPackStore } from './context-pack-store.js';
import type { ContextPackPin } from '@mitzo/protocol';

export const contextPackSourceRef = (pin: ContextPackPin) =>
  `context-pack:${pin.id}:${pin.revision}:${pin.hash}`;

/** Host composition supplies the accepted source. Neither recipes nor requests select it. */
export interface ContextPackRuntime {
  source: Pick<AcceptedKnowledgeSource, 'allowed' | 'read' | 'authorize'>;
  contextPacks: ContextPackStore;
  sourceIdentity: string;
}
let loader: (() => Promise<ContextPackRuntime | undefined>) | undefined;
export function installContextPackRuntime(resolve: () => Promise<ContextPackRuntime | undefined>) {
  const previous = loader;
  loader = resolve;
  return () => {
    if (loader === resolve) loader = previous;
  };
}
export async function getContextPackRuntime() {
  return loader?.();
}

/** Current operator authority is required in addition to the host's document enrollment. */
export function createAcceptedContextPacks(
  runtime: ContextPackRuntime,
  authority: { assertCurrent(): void; authorizeDocument?: AuthorizedContextPacks['authorize'] },
): AuthorizedContextPacks {
  const authorize: AuthorizedContextPacks['authorize'] = async (document, signal) => {
    signal?.throwIfAborted();
    authority.assertCurrent();
    if (!runtime.source.allowed(document.path))
      throw Error('Context document is outside the authorized Knowledge scope');
    await runtime.source.authorize(document.path, document.revision, signal);
    signal?.throwIfAborted();
    await authority.authorizeDocument?.(document, signal);
    authority.assertCurrent();
  };
  return {
    sourceIdentity: runtime.sourceIdentity,
    assertCurrent: () => authority.assertCurrent(),
    authorize,
    async resolve(pin) {
      authority.assertCurrent();
      const selected = runtime.contextPacks.getRevision(pin.id, pin.revision);
      if (selected.hash !== pin.hash)
        throw Error('Context pack hash differs from its pinned identity');
      return selected;
    },
    async readDocument(document, signal) {
      await authorize(document, signal);
      const source = await runtime.source.read(document.path, document.revision, signal);
      signal?.throwIfAborted();
      authority.assertCurrent();
      return { ...source, storeId: runtime.sourceIdentity };
    },
  };
}
