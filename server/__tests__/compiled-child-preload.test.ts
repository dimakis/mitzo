import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('packages the child DNS preload in compiled releases so Node integrations can start', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-compiled-preload-'));
  roots.push(root);
  const configPath = resolve('tsconfig.build.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(loaded.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, resolve('.'));
  // Compile the non-TypeScript runtime assets selected by the real build config.
  // The rest of the server is deliberately omitted from this focused packaging test.
  const program = ts.createProgram(
    config.fileNames.filter((file) => file.endsWith('.cjs')),
    { ...config.options, outDir: root, noEmit: false, types: [] },
  );
  expect(program.emit().emitSkipped).toBe(false);
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:dns').lookup('localhost', {all:true}, (error, addresses) => { if(error) throw error; console.log(JSON.stringify(addresses)); });",
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${join(root, 'ipv4-preload.cjs')}` },
      timeout: 5000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const addresses = JSON.parse(child.stdout) as Array<{ family: number }>;
  expect(addresses.length).toBeGreaterThan(0);
  expect(addresses.every((address) => address.family === 4)).toBe(true);
});
