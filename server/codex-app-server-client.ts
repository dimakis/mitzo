import { applicationVersion } from './application-version.js';
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute } from 'node:path';

type JsonObject = Record<string, unknown>;
interface RpcProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): unknown;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Explicit login storage; never pass API billing or arbitrary server secrets to Codex. */
export function codexEnvironment(
  credentialRef: string,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!isAbsolute(credentialRef)) throw new Error('Codex login directory must be absolute');
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (base[key]) env[key] = base[key];
  }
  return { ...env, CODEX_HOME: credentialRef };
}

/** Private stdio transport. It never retries a request with an uncertain outcome. */
export class CodexAppServerClient {
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private closed = false;
  private ready = false;
  private initializing?: Promise<void>;
  private readonly maxFrameBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private child: RpcProcess,
    options: { timeoutMs?: number; maxFrameBytes?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Provider diagnostics may contain private paths or credential material.
    child.stderr.resume();
    child.on('error', () => this.close());
    child.on('exit', () => this.close());
    child.stdin.on('error', () => this.close());
    child.stdout.on('error', () => this.close());
    child.stderr.on('error', () => this.close());
  }

  static launch(credentialRef: string, base: NodeJS.ProcessEnv = process.env) {
    return new CodexAppServerClient(
      spawn(
        'codex',
        [
          'app-server',
          '--stdio',
          '-c',
          'forced_login_method="chatgpt"',
          '-c',
          'model_provider="openai"',
        ],
        { env: codexEnvironment(credentialRef, base), stdio: ['pipe', 'pipe', 'pipe'] },
      ),
    );
  }

  initialize(): Promise<void> {
    this.initializing ??= this.sendRequest('initialize', {
      clientInfo: { name: 'mitzo', version: applicationVersion },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.write({ method: 'initialized', params: {} });
      this.ready = true;
    });
    return this.initializing;
  }

  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    if (!this.ready) return Promise.reject(new Error('Codex connection not initialized'));
    if (!['account/read', 'model/list'].includes(method))
      return Promise.reject(new Error('Codex connection supports preflight only'));
    return this.sendRequest(method, params);
  }

  close(error = new Error('Codex connection closed')) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.buffer = Buffer.alloc(0);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }

  private sendRequest(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error('Codex request timed out; retry explicitly')),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch {
        this.close();
      }
    });
  }

  private write(value: JsonObject) {
    if (this.closed) throw new Error('Codex connection closed');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  private receive(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      let newline: number;
      while ((newline = this.buffer.indexOf(10)) !== -1) {
        if (newline > this.maxFrameBytes) throw new Error();
        const frame: unknown = JSON.parse(this.buffer.subarray(0, newline).toString('utf8'));
        this.buffer = this.buffer.subarray(newline + 1);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
        const message = frame as JsonObject;
        if (typeof message.method === 'string') {
          // No tool execution is authorized by this connection foundation.
          if (message.id !== undefined) {
            try {
              this.write({
                id: message.id,
                error: { code: -32601, message: 'Unsupported Codex request' },
              });
            } catch {
              this.close();
              return;
            }
          }
          continue;
        }
        if (typeof message.id !== 'number') throw new Error();
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(new Error('Codex request failed; check configuration and retry'));
        else if ('result' in message) request.resolve(message.result);
        else {
          request.reject(new Error('Invalid Codex protocol'));
          throw new Error();
        }
      }
      if (this.buffer.length > this.maxFrameBytes) throw new Error();
    } catch {
      this.close(new Error('Invalid Codex protocol'));
    }
  }
}
