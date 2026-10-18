import { existsSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadAccountProfiles } from './account-profiles.js';
import { privateCodexRoots } from './codex-private-path.js';
import { canonical } from './sandbox-authority.js';
import { executeSandboxedCommand, type SandboxedCommandOptions } from './sandboxed-command.js';
import type { ToolBuilderExecutor } from './tool-builder.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Embedded like the native file helper: no build-copy step or user-supplied runner.
const examplesRunner = String.raw`
import {pathToFileURL} from 'node:url';
const [entry,encoded]=process.argv.slice(1);
const examples=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
const {runTool}=await import(pathToFileURL(entry).href);
if(typeof runTool!=='function') throw Error('src/index.mts must export runTool(input)');
const results=[];
for(const example of examples) results.push({actual:await runTool(structuredClone(example.input))});
process.stdout.write(JSON.stringify({results}));
`;
const exampleReport = z.strictObject({
  results: z.array(z.strictObject({ actual: z.record(z.string(), z.json()) })).max(20),
});
function completedTests(output: string) {
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((name) => [
      name,
      output.match(new RegExp(`^# ${name} ([0-9]+)$`, 'm'))?.[1],
    ]),
  );
  return (
    counts.tests &&
    Number(counts.tests) > 0 &&
    counts.pass === counts.tests &&
    ['fail', 'cancelled', 'skipped', 'todo'].every((name) => counts[name] === '0')
  );
}

export function createToolBuilderExecutor(
  options: {
    execute?: (input: SandboxedCommandOptions) => Promise<{ content: string; isError: boolean }>;
    privateRoots?: () => string[];
    assertCurrent?: () => void;
    assertRuntimeCurrent?: () => Promise<void>;
  } = {},
): ToolBuilderExecutor {
  return {
    async run({ workspace, profile, signal, examples }) {
      if (profile !== 'unit')
        throw Error('The requested development test profile is not installed');
      signal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
      signal.throwIfAborted();
      options.assertCurrent?.();
      const files = await workspace.snapshot();
      signal.throwIfAborted();
      options.assertCurrent?.();
      const tests = files.filter((file) =>
        /^test\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.test\.mts$/.test(file.path),
      );
      if (!files.some((file) => file.path === 'src/index.mts') || !tests.length)
        throw Error('The Node unit profile requires src/index.mts and test/*.test.mts files');
      const serialized = JSON.stringify(examples.map(({ input }) => ({ input })));
      if (Buffer.byteLength(serialized) > 32000)
        throw Error('Example inputs and results exceed the development limit');
      const execute = options.execute ?? executeSandboxedCommand;
      const privateRoots = (
        options.privateRoots ?? (() => privateCodexRoots(loadAccountProfiles().privateCodexRoots()))
      )().map(canonical);
      const runtimeRoots = [
        '/bin',
        '/usr/bin',
        '/usr/lib',
        '/usr/share',
        '/lib',
        '/lib64',
        '/System/Library',
        '/Library/Apple/System/Library',
        '/dev',
        '/opt/homebrew/Cellar',
        '/opt/homebrew/opt',
      ]
        .filter(existsSync)
        .map((path) => realpathSync(path));
      const common: Omit<SandboxedCommandOptions, 'command'> = {
        cwd: workspace.root,
        writableRoots: [workspace.root],
        readableRoots: [
          ...new Set([workspace.root, realpathSync(process.execPath), ...runtimeRoots]),
        ],
        deniedRoots: privateRoots,
        env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'C' },
        signal,
        timeoutMs: 60000,
        maxOutputBytes: 32000,
        beforeSpawn: options.assertCurrent,
        beforeSpawnAsync: options.assertRuntimeCurrent,
      };
      const node = `${quote(realpathSync(process.execPath))} --experimental-strip-types --max-old-space-size=128 --no-addons --disable-proto=throw --openssl-config=/dev/null`;
      const tested = await execute({
        ...common,
        command: `${node} --test --test-reporter=tap --test-concurrency=1 ${tests.map((file) => quote(file.path)).join(' ')}`,
      });
      signal.throwIfAborted();
      options.assertCurrent?.();
      if (tested.isError || !completedTests(tested.content))
        return {
          passed: false,
          complete: false,
          evidenceKind: 'candidate-report',
          summary: 'Unit tests failed, were skipped or did not complete',
          examples: [],
        };
      const result = await execute({
        ...common,
        command: `${node} --input-type=module -e ${quote(examplesRunner)} ${quote(workspace.root + '/src/index.mts')} ${quote(Buffer.from(serialized).toString('base64url'))}`,
      });
      signal.throwIfAborted();
      options.assertCurrent?.();
      const parsed = result.isError
        ? null
        : (() => {
            try {
              return exampleReport.parse(JSON.parse(result.content));
            } catch {
              return null;
            }
          })();
      if (!parsed || parsed.results.length !== examples.length)
        return {
          passed: false,
          complete: false,
          evidenceKind: 'candidate-report',
          summary: 'Example checks failed or did not complete',
          examples: [],
        };
      const checked = parsed.results.map((row, index) => ({
        actual: row.actual,
        passed: isDeepStrictEqual(row.actual, examples[index].expected),
      }));
      return {
        passed: checked.every((row) => row.passed),
        complete: true,
        evidenceKind: 'candidate-report',
        summary: `Candidate reported unit checks; parent compared ${checked.length} examples. Publication requires installed-source qualification.`,
        examples: checked,
      };
    },
  };
}
