import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AsyncQueue } from '@mitzo/protocol';
import {
  assertClaudeSubscriptionAccount,
  ClaudeSubscriptionCustody,
} from './claude-subscription-custody.js';
import { credentialSdkBoundary } from './credential-sdk-boundary.js';
import { createLogger } from './logger.js';
import type { CatalogModel } from './model-catalog.js';

const NativeModels = z
  .array(
    z.object({
      value: z.string().min(1),
      displayName: z.string().min(1),
      description: z.string().optional(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(z.enum(['low', 'medium', 'high', 'xhigh', 'max'])).optional(),
    }),
  )
  .min(1);

/** Native aliases may put their version in the description instead of the short label. */
export function claudeModelLabel(model: {
  value: string;
  displayName: string;
  description?: string;
}): string {
  const versionedName = /\b(?:Claude\s+)?(Opus|Sonnet|Haiku)\s+(\d+\.\d+)\b/i;
  if (versionedName.test(model.displayName)) return model.displayName;
  const family = /\b(opus|sonnet|haiku)\b/i.exec(model.value)?.[1];
  const described = /^(?:Claude\s+)?(Opus|Sonnet|Haiku)\s+(\d+\.\d+)\b/i.exec(
    model.description ?? '',
  );
  const exact = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:[.@[-]|$)/i.exec(model.value);
  const identity = exact
    ? [exact[1], `${exact[2]}.${exact[3]}`]
    : described && (!family || family.toLowerCase() === described[1].toLowerCase())
      ? [described[1], described[2]]
      : null;
  if (!identity) return model.displayName;
  const name = identity[0][0].toUpperCase() + identity[0].slice(1).toLowerCase();
  const version = `Claude ${name} ${identity[1]}`;
  const shortName = new RegExp(`\\b(?:Claude\\s+)?${name}\\b`, 'i');
  return shortName.test(model.displayName)
    ? model.displayName.replace(shortName, version)
    : `${version} · ${model.displayName}`;
}

/** Initialize the selected subscription's native control plane; never submit a user turn. */
export async function discoverClaudeModels(
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<CatalogModel[]> {
  signal.throwIfAborted();
  const custody = ClaudeSubscriptionCustody.capture(env);
  await custody.verify(env, signal);
  const cwd = await mkdtemp(join(tmpdir(), 'mitzo-claude-models-'));
  const input = new AsyncQueue<SDKUserMessage>();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let client: Query | undefined;
  try {
    signal.throwIfAborted();
    const boundary = credentialSdkBoundary();
    custody.assertCurrent(env);
    client = query({
      prompt: input,
      options: {
        cwd,
        env,
        abortController: controller,
        pathToClaudeCodeExecutable: custody.snapshot().executable.path,
        settingSources: [],
        settings: { disableAllHooks: true },
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        plugins: [],
        persistSession: false,
        ...(boundary ? { spawnClaudeCodeProcess: boundary.spawnClaudeCodeProcess } : {}),
      },
    });
    // Race control-plane reads too: a stalled SDK must not hold refresh indefinitely.
    const read = async () => {
      const account = await client!.accountInfo();
      signal.throwIfAborted();
      assertClaudeSubscriptionAccount(account, env);
      const models = NativeModels.parse(await client!.supportedModels());
      signal.throwIfAborted();
      await custody.verify(env, signal);
      signal.throwIfAborted();
      return models.map((model) => ({
        id: model.value,
        label: claudeModelLabel(model),
        ...(model.supportsEffort && model.supportedEffortLevels?.length
          ? { reasoningEfforts: model.supportedEffortLevels }
          : {}),
      }));
    };
    return await new Promise<CatalogModel[]>((resolve, reject) => {
      const cancelled = () =>
        reject(signal.reason ?? new Error('Claude model discovery cancelled'));
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      else
        read()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancelled));
    });
  } finally {
    signal.removeEventListener('abort', abort);
    input.close();
    controller.abort();
    try {
      client?.close();
    } catch {
      createLogger('claude-model-discovery').warn('Claude discovery query cleanup failed', {
        code: 'claude_model_discovery_close_failed',
        stage: 'metadata_cleanup',
      });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {
        createLogger('claude-model-discovery').warn('Claude discovery workspace cleanup failed', {
          code: 'claude_model_discovery_cleanup_failed',
          stage: 'metadata_cleanup',
        });
      });
    }
  }
}
