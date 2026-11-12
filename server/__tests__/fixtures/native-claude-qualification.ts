import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AsyncQueue } from '../../async-queue.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Require the real installed wrapper even when an adapter test mocks its ESM
// import. The prompt yields no input; all credentials and home paths are
// synthetic, and the only provider endpoint rejects requests on loopback.
const require = createRequire(import.meta.url);
const sdk =
  require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const platform = `${process.platform}-${process.arch}`;
export const lockedClaudeExecutable = join(sdkRoot, '..', `claude-agent-sdk-${platform}`, 'claude');
const pkg = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(sdkRoot, 'manifest.json'), 'utf8'));
if (pkg.version !== '0.3.322' || manifest.version !== '2.1.322')
  throw Error('Requalify the locked Claude child-env mechanism');
const checksum = createHash('sha256');
for await (const chunk of createReadStream(lockedClaudeExecutable)) checksum.update(chunk);
if (checksum.digest('hex') !== manifest.platforms[platform]?.checksum)
  throw Error('Locked Claude binary qualification failed');

type Mode = 'plan' | 'default';
type Receipt = { response: { subtype: string; response?: { mode?: string } } };
async function probe(env: NodeJS.ProcessEnv, modes: Mode[]) {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-qualification-'));
  const snapshot = join(root, 'child-result');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(503);
    response.end('Offline qualification does not serve inference');
  });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(Error('Native offline qualification timed out')),
    15000,
  );
  let native: ReturnType<typeof sdk.query> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const prompt = new AsyncQueue<SDKUserMessage>();
  const responses: Receipt[] = [];
  let startupOverride = false;
  let childError: unknown;
  let primaryError: unknown;
  let result:
    | { receipts: Map<string, { mode: Mode; responses: Receipt[] }>; childObservation: string }
    | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Offline endpoint unavailable');
    const syntheticEnv = {
      ...env,
      HOME: root,
      PATH: '/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: root,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? 'offline-synthetic-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    native = sdk.query({
      prompt,
      options: {
        cwd: root,
        env: syntheticEnv,
        abortController: controller,
        permissionMode: 'plan',
        persistSession: false,
        settingSources: [],
        mcpServers: {},
        pathToClaudeCodeExecutable: lockedClaudeExecutable,
        settings: {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `/bin/bash --noprofile --norc -c 'if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then printf scrubbed; else printf inherited; fi' > '${snapshot}'`,
                  },
                ],
              },
            ],
          },
        },
        spawnClaudeCodeProcess: (input) => {
          // Explicitly replace the complete child environment; never inherit
          // the operator's configuration, credentials or provider endpoints.
          child = spawn(input.command, input.args, {
            cwd: root,
            env: syntheticEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            signal: controller.signal,
          });
          child.once('error', (error) => {
            childError = error;
            controller.abort(error);
          });
          let stderrTail = '';
          child.stderr!.on('data', (chunk) => {
            stderrTail = (stderrTail + String(chunk)).slice(-1024);
            startupOverride ||= stderrTail.includes('Permission mode forced to default');
          });
          let incoming = '';
          child.stdout!.on('data', (chunk) => {
            incoming += String(chunk);
            let end: number;
            try {
              while ((end = incoming.indexOf('\n')) >= 0) {
                const message = JSON.parse(incoming.slice(0, end));
                incoming = incoming.slice(end + 1);
                if (message.type === 'control_response') responses.push(message);
              }
            } catch (error) {
              childError = new Error('Native qualification protocol invalid', { cause: error });
              controller.abort(childError);
            }
          });
          return child as ReturnType<
            NonNullable<import('@anthropic-ai/claude-agent-sdk').Options['spawnClaudeCodeProcess']>
          >;
        },
      },
    });
    await native.initializationResult();
    if (!startupOverride) throw Error('Actual scrub startup no longer forces default mode');
    const receipts = new Map<string, { mode: Mode; responses: Receipt[] }>();
    let current: Mode = 'default';
    for (const mode of modes) {
      const start = responses.length;
      await native.setPermissionMode(mode);
      const ack = responses.slice(start);
      if (
        ack.length !== 1 ||
        ack[0].response.subtype !== 'success' ||
        ack[0].response.response?.mode !== mode
      )
        throw Error('Actual native permission acknowledgement changed');
      receipts.set(`${current}:${mode}`, { mode, responses: ack });
      current = mode;
    }
    const childObservation = await readFile(snapshot, 'utf8');
    if (requests !== 0) throw Error('Offline qualification attempted a provider request');
    result = { receipts, childObservation };
  } catch (error) {
    primaryError = childError ?? error;
  }
  clearTimeout(timer);
  prompt.close();
  try {
    // Keep the synthetic home until its owned native process has exited.
    const closed =
      child && child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => child!.once('close', () => resolve()))
        : Promise.resolve();
    native?.close();
    controller.abort();
    await closed;
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, cleanupError],
          'Native qualification and cleanup failed',
          { cause: primaryError },
        )
      : cleanupError;
  }
  if (primaryError) throw primaryError;
  if (!result) throw Error('Native qualification did not produce a result');
  return result;
}

// Qualify all four transitions once against actual native control responses.
// Adapter peers replay these current-runtime receipts without model input.
const qualified = await probe({}, ['plan', 'plan', 'default', 'default']);
export function lockedClaudeStartupMode(env: NodeJS.ProcessEnv, mode: Mode) {
  if (env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1' || !['plan', 'default'].includes(mode))
    throw Error('Unqualified offline startup scenario');
  return 'default';
}
export function lockedClaudeControlMode(mode: Mode, current: string) {
  const receipt = qualified.receipts.get(`${current}:${mode}`);
  if (!receipt) throw Error('Unqualified offline permission transition');
  return receipt;
}
export async function lockedClaudeBashCredentialObservation(env: NodeJS.ProcessEnv) {
  const value = env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN;
  if (
    value !== 'offline-synthetic-billing-sentinel' ||
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== '1'
  )
    throw Error('Native child qualification requires the explicit synthetic billing fixture');
  return (await probe(env, [])).childObservation;
}
