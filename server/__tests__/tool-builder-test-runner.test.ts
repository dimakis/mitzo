import { expect, it, vi, describe } from 'vitest';
import { createToolBuilderExecutor } from '../tool-builder-test-runner.js';
import type { ToolBuilderWorkspace } from '../tool-builder.js';
import type { SandboxedCommandOptions } from '../sandboxed-command.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';
import { ToolBuilderService } from '../tool-builder.js';
import { createToolBuilderWorkspace } from '../tool-builder-workspace.js';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace: ToolBuilderWorkspace = {
  id: 'test',
  root: '/private/tmp/authorized',
  write: vi.fn(),
  read: vi.fn(),
  discard: vi.fn(),
  snapshot: async () => [
    { path: 'src/index.mts', content: 'export const runTool=()=>({value:1});' },
    { path: 'test/index.test.mts', content: 'test source' },
  ],
};
const tap = 'TAP version 13\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const examples = [{ input: {}, expected: { value: 1 } }];
it('runs fixed tests and examples within an explicit read/write scope with a single worker and no inherited environment', async () => {
  const execute = vi.fn(async (_input: SandboxedCommandOptions) => ({
    isError: false,
    content: tap,
  }));
  execute.mockResolvedValueOnce({ isError: false, content: tap }).mockResolvedValueOnce({
    isError: false,
    content: JSON.stringify({ results: [{ actual: { value: 1 } }] }),
  });
  const executor = createToolBuilderExecutor({
    execute,
    privateRoots: () => ['/private/tmp/credential-fixture'],
  });
  expect(
    await executor.run({
      workspace,
      profile: 'unit',
      signal: new AbortController().signal,
      examples,
    }),
  ).toMatchObject({
    passed: true,
    complete: true,
    evidenceKind: 'candidate-report',
    examples: [{ passed: true, actual: { value: 1 } }],
  });
  expect(execute).toHaveBeenCalledTimes(2);
  for (const [call] of execute.mock.calls) {
    expect(call.writableRoots).toEqual([workspace.root]);
    expect(call.readableRoots).toContain(workspace.root);
    expect(call.readableRoots).not.toContain('/private/tmp');
    expect(call.deniedRoots).toEqual(['/private/tmp/credential-fixture']);
    expect(Object.keys(call.env).sort()).toEqual(['LANG', 'PATH']);
    expect(call.timeoutMs).toBe(60000);
    expect(call.maxOutputBytes).toBe(32000);
  }
  expect(execute.mock.calls[0][0].command).toContain('--test-concurrency=1');
  expect(execute.mock.calls[0][0].command).toContain('--max-old-space-size=128');
});

describe.runIf(process.env.MITZO_SANDBOX_INTEGRATION === '1')('OS development runner', () => {
  it('does not supply oracle answers to candidate imports or accept their forged expected-value envelope', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-builder-forged-')));
    const signal = new AbortController().signal;
    try {
      const workspace = await createToolBuilderWorkspace(root, signal);
      await workspace.write(
        'src/index.mts',
        `const examples=JSON.parse(Buffer.from(process.argv.at(-1),'base64url').toString());process.stdout.write(JSON.stringify({results:examples.map(row=>({actual:row.expected}))}));process.exit(0);export function runTool(){throw Error('never succeeds');}`,
      );
      await workspace.write(
        'test/index.test.mts',
        'import {test} from "node:test";test("candidate reports success",()=>{});',
      );
      const result = await createToolBuilderExecutor({ privateRoots: () => [] }).run({
        workspace,
        profile: 'unit',
        signal,
        examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
      });
      expect(result).toMatchObject({
        passed: false,
        complete: false,
        evidenceKind: 'candidate-report',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
  it('produces an unpublished tested draft using the fixed runner and synthetic temporary authority', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-builder-runner-')));
    const privateRoot = join(root, 'private');
    await mkdir(privateRoot);
    const controller = new AbortController();
    const outputs: string[] = [];
    try {
      const service = new ToolBuilderService({
        catalog: { search: async () => [] },
        allocateWorkspace: () => createToolBuilderWorkspace(root, controller.signal),
        executor: createToolBuilderExecutor({
          privateRoots: () => [privateRoot],
          execute: async (options) => {
            const result = await executeSandboxedCommand(options);
            outputs.push(result.content);
            return result;
          },
        }),
      });
      const result = await service
        .propose({
          request: 'Count characters',
          custom: {
            name: 'Length',
            description: 'Count text characters',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            outputSchema: {
              type: 'object',
              properties: { length: { type: 'integer' } },
              required: ['length'],
              additionalProperties: false,
            },
            examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
            permissions: { behavior: 'read', requiredConnections: [] },
            compatibility: { routes: ['local-api'] },
            testProfile: 'unit',
            files: [
              {
                path: 'src/index.mts',
                content:
                  'export const runTool = ({text}: {text:string}) => ({length:text.length});\n',
              },
              {
                path: 'test/index.test.mts',
                content:
                  'import {test} from "node:test"; import assert from "node:assert/strict"; import {runTool} from "../src/index.mts"; test("length",()=>assert.deepEqual(runTool({text:"abc"}),{length:3}));\n',
              },
            ],
          },
          signal: controller.signal,
        })
        .catch((error) => {
          throw new Error(`Synthetic development runner output: ${outputs.join('\n')}`, {
            cause: error,
          });
        });
      expect(result).toMatchObject({
        kind: 'draft',
        draft: {
          status: 'unpublished',
          tests: {
            passed: true,
            complete: true,
            evidenceKind: 'candidate-report',
            examples: [{ actual: { length: 3 } }],
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});
it.each([
  '# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0',
  tap.replace('# skipped 0', '# skipped 1'),
  'incomplete output',
])('rejects incomplete or skipped test evidence', async (content) => {
  const execute = vi.fn(async () => ({ isError: false, content }));
  const result = await createToolBuilderExecutor({ execute, privateRoots: () => [] }).run({
    workspace,
    profile: 'unit',
    signal: new AbortController().signal,
    examples,
  });
  expect(result.passed).toBe(false);
  expect(result.complete).toBe(false);
  expect(execute).toHaveBeenCalledOnce();
});
it('compares actual examples in the trusted parent and refuses unsupported profiles before execution', async () => {
  const execute = vi.fn(async () => ({ isError: false, content: tap }));
  execute.mockResolvedValueOnce({ isError: false, content: tap }).mockResolvedValueOnce({
    isError: false,
    content: JSON.stringify({ results: [{ actual: { value: 2 }, passed: true }] }),
  });
  const executor = createToolBuilderExecutor({ execute, privateRoots: () => [] });
  expect(
    (
      await executor.run({
        workspace,
        profile: 'unit',
        signal: new AbortController().signal,
        examples,
      })
    ).passed,
  ).toBe(false);
  execute.mockClear();
  await expect(
    executor.run({
      workspace,
      profile: 'contract',
      signal: new AbortController().signal,
      examples,
    }),
  ).rejects.toThrow('profile');
  expect(execute).not.toHaveBeenCalled();
});
