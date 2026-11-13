import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createLogger } from './logger.js';
import type {
  HookEvent,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProtectedSdkCommandRunner } from './protected-sdk-command.js';

const log = createLogger('hooks');

function hookEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const controllerKeys = new Set([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'AUTH_PASSPHRASE',
    'AUTH_SECRET',
    'NTFY_AUTH_TOKEN',
  ]);
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) => typeof value === 'string' && !controllerKeys.has(key),
    ),
  ) as Record<string, string>;
}

/** Shape of a single hook entry in settings.json */
const settingsHooks = z.record(
  z.string().refine((event) => HOOK_EVENTS.includes(event as HookEvent)),
  z.array(
    z.strictObject({
      matcher: z
        .string()
        .refine((value) => {
          try {
            if (value !== '*') new RegExp(value);
            return true;
          } catch {
            return false;
          }
        })
        .optional(),
      hooks: z.array(z.strictObject({ type: z.literal('command'), command: z.string().min(1) })),
      timeout: z.number().positive().max(300).optional(),
    }),
  ),
);
type SettingsHooks = z.infer<typeof settingsHooks>;

// Top-level fields in SyncHookJSONOutput (everything else is hook-specific)
const SDK_TOP_LEVEL_KEYS = new Set([
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'systemMessage',
  'reason',
]);
const commonOutput = z
  .object({
    continue: z.boolean().optional(),
    suppressOutput: z.boolean().optional(),
    stopReason: z.string().optional(),
    decision: z.enum(['approve', 'block']).optional(),
    systemMessage: z.string().optional(),
    reason: z.string().optional(),
  })
  .catchall(z.unknown());
const specificOutput = z
  .object({
    hookEventName: z.string().optional(),
    permissionDecision: z.enum(['allow', 'ask', 'deny']).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * Read and parse the hooks section from a settings.json file.
 */
export function parseSettingsHooks(settingsPath: string): SettingsHooks | null {
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('hooks' in parsed))
      return null;
    return settingsHooks.parse(parsed?.hooks);
  } catch (err: unknown) {
    log.warn('Project hook configuration rejected', {
      code: 'project_hook_configuration_invalid',
      stage: 'configuration',
      cause: err instanceof SyntaxError ? 'invalid_json' : 'invalid_or_unsupported_configuration',
    });
    throw new Error(
      'Project hook configuration is invalid or unsupported. Check event names, command types, matchers and timeouts.',
      { cause: err },
    );
  }
}

/**
 * Expand environment variables ($VAR or ${VAR}) in a command string.
 * Unknown variables are left unchanged.
 */
export function expandEnvVars(command: string, env: Record<string, string>): string {
  return command.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      const name = braced || bare;
      return name in env ? env[name] : match;
    },
  );
}

/**
 * Map raw JSON output from a hook script to SDK SyncHookJSONOutput.
 * Top-level SDK fields pass through; everything else goes into hookSpecificOutput.
 */
export function mapHookOutput(raw: unknown, hookEventName: string): SyncHookJSONOutput {
  const parsed = commonOutput.parse(raw);
  if ('async' in parsed) throw new Error('Asynchronous project hooks are unsupported');
  const result: Record<string, unknown> = {};
  const specific =
    parsed.hookSpecificOutput === undefined ? {} : specificOutput.parse(parsed.hookSpecificOutput);
  if ('hookEventName' in specific && specific.hookEventName !== hookEventName)
    throw new Error('Project hook event does not match');

  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'hookSpecificOutput') continue;
    if (SDK_TOP_LEVEL_KEYS.has(key)) {
      result[key] = value;
    } else {
      if (key in specific) throw new Error('Conflicting project hook output');
      specific[key] = value;
    }
  }

  if (Object.keys(specific).length > 0) {
    result.hookSpecificOutput = { ...specificOutput.parse(specific), hookEventName };
  }

  return result as SyncHookJSONOutput;
}

/**
 * Create an SDK HookCallback from a shell command string.
 * Spawns the command, pipes HookInput as JSON to stdin,
 * and parses stdout as SyncHookJSONOutput.
 */
export function createCommandCallback(
  command: string,
  cwd: string,
  timeoutMs: number,
  environment: Record<string, string> = hookEnvironment(process.env),
  runner?: ProtectedSdkCommandRunner,
): (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput> {
  const env = hookEnvironment(environment);
  return async (input, _toolUseID, options) => {
    const hookEventName =
      input && typeof input === 'object' && 'hook_event_name' in input
        ? String((input as Record<string, unknown>).hook_event_name)
        : 'unknown';

    let stage = 'command';
    try {
      options.signal.throwIfAborted();
      const commandOptions = {
        cwd,
        env,
        timeout: timeoutMs,
        signal: options.signal,
        maxBuffer: 256 * 1024,
      };
      const stdout = runner
        ? (
            await runner('/bin/sh', ['-c', command], {
              ...commandOptions,
              input: JSON.stringify(input),
            })
          ).stdout
        : await new Promise<string>((resolve, reject) => {
            const child = execFile('/bin/sh', ['-c', command], commandOptions, (error, stdout) =>
              error ? reject(error) : resolve(stdout),
            );
            // EPIPE after cancellation is settled by the command callback.
            child.stdin?.on('error', () => {});
            child.stdin?.end(JSON.stringify(input));
          });
      options.signal.throwIfAborted();
      stage = 'output';
      return stdout.trim() ? mapHookOutput(JSON.parse(stdout.trim()), hookEventName) : {};
    } catch (error) {
      const cause = options.signal.aborted
        ? 'cancelled'
        : error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : stage === 'output'
            ? 'invalid_output'
            : 'command_failed';
      log.warn('Project hook failed', {
        code: 'project_hook_failed',
        stage,
        cause,
        event: hookEventName,
        sessionId: 'session_id' in input ? input.session_id : undefined,
      });
      return {
        continue: false,
        stopReason: `Project ${hookEventName} hook failed at ${stage}. Inspect current state before retrying; hook commands${hookEventName.startsWith('PostTool') ? ' and the tool' : ''} may already have run.`,
      };
    }
  };
}

/**
 * Load project hooks from .claude/settings.json and convert to SDK format.
 * Returns undefined if no hooks are defined.
 */
export function loadProjectHooks(
  cwd: string,
  environment: Record<string, string> = hookEnvironment(process.env),
  runner?: ProtectedSdkCommandRunner,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  const raw = parseSettingsHooks(settingsPath);
  if (!raw) return undefined;

  const env: Record<string, string> = {
    ...hookEnvironment(environment),
    CLAUDE_PROJECT_DIR: cwd,
  };

  const result: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  let hasHooks = false;

  for (const [eventName, matchers] of Object.entries(raw)) {
    const sdkMatchers: HookCallbackMatcher[] = [];

    for (const matcher of matchers) {
      const callbacks = matcher.hooks.map((h) => {
        const expanded = expandEnvVars(h.command, env);
        const timeoutMs = (matcher.timeout ?? 60) * 1000;
        return createCommandCallback(expanded, cwd, timeoutMs, env, runner);
      });

      if (callbacks.length === 0) continue;

      sdkMatchers.push({
        ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
        hooks: callbacks,
        ...(matcher.timeout ? { timeout: matcher.timeout } : {}),
      });
    }

    if (sdkMatchers.length > 0) {
      result[eventName as HookEvent] = sdkMatchers;
      hasHooks = true;
    }
  }

  if (!hasHooks) return undefined;

  const events = Object.keys(result).join(', ');
  log.info(`loaded project hooks: ${events}`);
  return result;
}
