import type { AgentToolReference } from '@mitzo/protocol';
import type { buildPermissionHandler } from '@mitzo/harness';
import { isDeepStrictEqual } from 'node:util';
import { compileToolBuilderSchema } from './tool-builder-schema.js';
import type { ToolBuilderStore } from './tool-builder-store.js';

/** Admission pins definitions and receipts; assignment never grants execution. */
export function admitCustomTools(options: {
  store: ToolBuilderStore;
  refs: AgentToolReference[];
  approve: ReturnType<typeof buildPermissionHandler>;
  stillAllowed(name: string): boolean;
  assertCurrent(): void;
  assertRuntimeCurrent?: () => Promise<void>;
  captureAuthority?: () => { signal: AbortSignal; assertCurrent(): void; dispose(): void };
}) {
  options.assertCurrent();
  const receipts = options.refs.map((ref) => {
    const publication = options.store.resolve('user', ref);
    const record = options.store.read('user', ref.id.slice(7), ref.version)!;
    return {
      publication,
      draft: record.draft,
      input: compileToolBuilderSchema(record.draft.inputSchema),
    };
  });
  return {
    definitions: receipts.map((receipt) => structuredClone(receipt.publication.binding.definition)),
    admitted: receipts.map((receipt) => ({
      wireName: receipt.publication.binding.definition.name,
      reference: receipt.publication.reference,
    })),
    async execute(
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      call: { callId: string; forcePrompt?: boolean },
    ) {
      const receipt = receipts.find(
        (receipt) => receipt.publication.binding.definition.name === name,
      );
      if (!receipt) return undefined;
      let authority: ReturnType<NonNullable<typeof options.captureAuthority>> | undefined;
      const check = () => {
        signal.throwIfAborted();
        authority?.assertCurrent();
        options.assertCurrent();
        options.store.resolve('user', receipt.publication.reference);
        if (!options.stillAllowed(name))
          throw Error('Custom tool is not currently selected or permitted');
      };
      try {
        authority = options.captureAuthority?.();
        signal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30000),
          ...(authority ? [authority.signal] : []),
        ]);
        check();
        const requested = structuredClone(input);
        receipt.input.validate(requested);
        if (Buffer.byteLength(JSON.stringify(requested)) > 8000 || !call.callId)
          throw Error('Custom invocation identity or input is unavailable');
        await options.assertRuntimeCurrent?.();
        check();
        const approved = await options.approve(name, structuredClone(requested), {
          signal,
          toolUseID: call.callId,
          forcePrompt: call.forcePrompt,
          sessionGrantKey: JSON.stringify(['custom-tool', receipt.publication.reference]),
          approvalScope: 'conversation',
          title: `Use ${receipt.draft.name}?`,
          description:
            'Run this accepted read-only implementation with the displayed input. Selection does not grant connection or filesystem access.',
        });
        await options.assertRuntimeCurrent?.();
        check();
        if (approved.behavior !== 'allow' || !isDeepStrictEqual(approved.updatedInput, requested))
          return {
            content: 'Custom tool approval denied or changed. Retry the exact intended input.',
            isError: true,
          };
        return await options.store.registry.invoke(
          receipt.draft,
          receipt.publication.binding,
          requested,
          { signal, assertCurrent: check },
        );
      } catch {
        return {
          content: signal.aborted
            ? 'Custom tool invocation cancelled'
            : 'Custom tool unavailable. Check selection, approval and the installed source version; start a new session after changes.',
          isError: true,
        };
      } finally {
        authority?.dispose();
      }
    },
  };
}
