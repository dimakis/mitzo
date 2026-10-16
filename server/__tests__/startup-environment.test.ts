import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Cover the child process's 20-second startup budget plus fixture cleanup on busy CI runners.
it('boots with authentication, workspace and tracing settings supplied only by the default dotenv file', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-startup-env-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  try {
    writeFileSync(
      join(root, '.env'),
      [
        'AUTH_PASSPHRASE=startup-fixture-passphrase',
        'AUTH_SECRET=startup-fixture-secret-long-enough-for-hs256',
        `REPO_PATH=${JSON.stringify(workspace)}`,
        'MITZO_OPENSHELL_ENABLED=0',
        'MITZO_BIND_HOST=127.0.0.1',
        'PORT=4199',
        'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318',
        'TRACE_CONTENT_MAX_CHARS=1234',
      ].join('\n'),
    );
    const gate = join(root, 'before-listen.mjs');
    // Execute real bootstrap imports, but refuse every socket bind and outbound request.
    // This fixture starts no app backend, provider, sandbox, or model turn.
    writeFileSync(
      gate,
      `
      import net from 'node:net';
      globalThis.fetch = async () => new Response('offline fixture', { status: 503 });
      net.Socket.prototype.connect = function () {
        queueMicrotask(() => this.emit('error', new Error('offline fixture refuses outbound sockets')));
        return this;
      };
      net.Server.prototype.listen = function () {
        Promise.all([
          import(${JSON.stringify(new URL('../constants.ts', import.meta.url).href)}),
          import(${JSON.stringify(createRequire(import.meta.url).resolve('@opentelemetry/api'))}),
        ]).then(([constants, { trace }]) => {
          const span = trace.getTracer('startup-fixture').startSpan('dotenv-configuration');
          const ready = process.env.AUTH_PASSPHRASE === 'startup-fixture-passphrase'
            && process.env.AUTH_SECRET === 'startup-fixture-secret-long-enough-for-hs256'
            && process.env.REPO_PATH === ${JSON.stringify(workspace)}
            && constants.TRACE_CONTENT_MAX_CHARS === 1234
            && span.isRecording();
          process.stdout.write('STARTUP_ENV_READY=' + ready + '\\n');
          process.exit(ready ? 0 : 71);
        }).catch((error) => { console.error(error); process.exit(72); });
        return this;
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        gate,
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('../index.ts', import.meta.url)),
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), NODE_ENV: 'test' },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('STARTUP_ENV_READY=true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
