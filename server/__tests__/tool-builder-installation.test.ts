import { expect, it } from 'vitest';
import ts from 'typescript';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('emits an installed typed draft and its static registration through the real compiler contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-builder-install-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src/index.mts'),
      'export function runTool(input: {text: string}) { return {length: input.text.length}; }\n',
    );
    await writeFile(
      join(root, 'registration.mts'),
      'import {runTool} from "./src/index.mts"; export {runTool};\n',
    );
    const config = ts.getParsedCommandLineOfConfigFile(
      resolve('tsconfig.build.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic(diagnostic) {
          throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    )!;
    const options = {
      ...config.options,
      rootDir: root,
      outDir: join(root, 'dist'),
      types: [],
      lib: ['lib.es2022.d.ts'],
      incremental: false,
      noEmit: false,
    };
    const program = ts.createProgram([join(root, 'registration.mts')], options);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
    expect(program.emit().emitSkipped).toBe(false);
    expect(await readFile(join(root, 'dist/registration.mjs'), 'utf8')).toContain(
      './src/index.mjs',
    );
    expect(await readFile(join(root, 'dist/src/index.mjs'), 'utf8')).toContain('input.text.length');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
