import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  CodexAppServerClient,
  assertSupportedCodexCliVersion,
} from '../codex-app-server-client.js';
import { execFileSync } from 'node:child_process';
import { searchCodex } from '../codex-approved-search.js';

// Opt-in executable contract test. The only upstream is this loopback fixture;
// credentials, HOME and CODEX_HOME are disposable. No real model is called.
it.skipIf(!process.env.MITZO_CODEX_OFFLINE_EXECUTABLE)(
  'offers executable web search in the real pinned code-mode request on a custom API provider',
  async () => {
    const executable = process.env.MITZO_CODEX_OFFLINE_EXECUTABLE!;
    assertSupportedCodexCliVersion(execFileSync(executable, ['--version'], { encoding: 'utf8' }));
    const root = mkdtempSync(join(tmpdir(), 'mitzo-search-tools-'));
    const abort = new AbortController();
    let capture!: (value: string) => void;
    const captured = new Promise<string>((resolve) => {
      capture = resolve;
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.method === 'POST') capture(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'Offline fixture: no inference', type: 'invalid_request_error' },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
    let client: CodexAppServerClient | undefined;
    try {
      const search = searchCodex('Search for fixture evidence', abort.signal, {
        model: 'gpt-6-luna', // A fixture catalog entry, never a paid model request.
        modelProvider: 'openshell',
        cwd: root,
        disableProjectDocuments: true,
        createClient: (lifecycle) => {
          const child = spawn(
            executable,
            [
              'app-server',
              '--stdio',
              '-c',
              'model_provider="openshell"',
              '-c',
              `model_providers.openshell={ name = "Offline fixture", base_url = "http://127.0.0.1:${address.port}/v1", env_key = "OFFLINE_FIXTURE_KEY", wire_api = "responses" }`,
              '-c',
              'features.enable_request_compression=false',
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: root,
                CODEX_HOME: root,
                OFFLINE_FIXTURE_KEY: 'fixture-only',
                RUST_LOG: 'off',
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          );
          client = new CodexAppServerClient(child, { lifecycle });
          return client;
        },
        verify: async () => {},
      });
      void search.catch(() => {});
      const payload = await Promise.race([
        captured,
        search.then(() => {
          throw new Error('Search unexpectedly completed');
        }),
      ]);
      abort.abort();
      await search.catch(() => {});
      // Code-mode-only models carry nested tool definitions in exec's description.
      expect(
        /web(?:__|\.)run|"name"\s*:\s*"web"/.test(payload),
        'Actual model request must expose executable web search',
      ).toBe(true);
      expect(payload).not.toContain('RequestWebAccess');
      expect(/exec_command\(args:|"name"\s*:\s*"exec_command"/.test(payload)).toBe(false);
    } finally {
      abort.abort();
      client?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
