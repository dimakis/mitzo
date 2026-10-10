import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: transport.execute }));
import { createSymposiumHostToolBridge } from '../symposium-host-tool-bridge.js';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';
afterEach(() => vi.clearAllMocks());

it('pins the host continuation fence in the reviewed runtime artifacts', () => {
  expect(Object.hasOwn(reviewedHandlerSourceArtifacts, '../symposium-host-tool-bridge.ts')).toBe(
    true,
  );
});

it.each([false, true])(
  'reauthorizes after host tool work before returning its result (revoked=%s)',
  async (revoked) => {
    const writes: Array<{ operation: string; payload: unknown }> = [];
    let took = false;
    transport.execute.mockImplementation((_command, args, _options, callback) => {
      const operation = args.at(-1).split("'").filter(Boolean).at(-1);
      const stdin = Object.assign(new EventEmitter(), {
        end: (payload: string) => {
          writes.push({ operation, payload: JSON.parse(payload) });
          const calls =
            operation === 'take' && !took
              ? [
                  {
                    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                    name: 'ReadEvidence',
                    arguments: {},
                  },
                ]
              : [];
          if (operation === 'take') took = true;
          callback(null, operation === 'take' ? JSON.stringify(calls) : '');
        },
      });
      return { stdin };
    });
    let current = true;
    const authorize = vi.fn(async () => {
      if (!current) throw Error('Accepted source revoked');
    });
    const executeTool = vi.fn(async () => {
      await Promise.resolve();
      current = !revoked;
      return { content: 'tool evidence', isError: false };
    });
    const bridge = await createSymposiumHostToolBridge({
      sandbox: {
        sandboxName: 'fixture',
        workdir: '/sandbox/workspaces/mgmt',
        cli: 'openshell',
        gateway: 'fixture',
        workspace: 'fixture',
      },
      claimToken: 'claim',
      signal: new AbortController().signal,
      verifyCurrent() {},
      tools: {
        tools: [{ name: 'ReadEvidence', description: '', input_schema: { type: 'object' } }],
        instructions: '',
        executeTool,
      },
      prepareAgentContext: authorize,
    });
    const rejected = revoked
      ? expect(bridge.failed).rejects.toThrow(/bridge failed|claim changed/)
      : undefined;
    bridge.activate();
    try {
      await vi.waitFor(() => expect(executeTool).toHaveBeenCalledOnce());
      if (rejected) await rejected;
      else
        await vi.waitFor(() =>
          expect(writes.some(({ operation }) => operation === 'put')).toBe(true),
        );
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(writes.filter(({ operation }) => operation === 'put')).toHaveLength(revoked ? 0 : 1);
    } finally {
      await bridge.close();
    }
  },
);
