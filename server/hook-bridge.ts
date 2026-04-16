import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { createLogger } from './logger.js';
import type {
  HookEvent,
  HookCallbackMatcher,
  HookInput,
  HookJSONOutput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

const log = createLogger('hooks');

/** Shape of a single hook entry in settings.json */
interface SettingsHookCommand {
  type: 'command';
  command: string;
}

/** Shape of a matcher group in settings.json */
interface SettingsHookMatcher {
  matcher?: string;
  hooks: SettingsHookCommand[];
  timeout?: number;
}

/** Shape of the hooks section in settings.json */
type SettingsHooks = Partial<Record<string, SettingsHookMatcher[]>>;

// Top-level fields in SyncHookJSONOutput (everything else is hook-specific)
const SDK_TOP_LEVEL_KEYS = new Set([
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'systemMessage',
  'reason',
]);

/**
 * Read and parse the hooks section from a settings.json file.
 */
export function parseSettingsHooks(settingsPath: string): SettingsHooks | null {
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.hooks || typeof parsed.hooks !== 'object') return null;
    return parsed.hooks as SettingsHooks;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to parse hooks from ${settingsPath}: ${message}`);
    return null;
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
export function mapHookOutput(
  raw: Record<string, unknown>,
  hookEventName: string,
): SyncHookJSONOutput {
  const result: Record<string, unknown> = {};
  const specific: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (SDK_TOP_LEVEL_KEYS.has(key)) {
      result[key] = value;
    } else {
      specific[key] = value;
    }
  }

  if (Object.keys(specific).length > 0) {
    result.hookSpecificOutput = { hookEventName, ...specific };
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
): (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput> {
  return async (input, _toolUseID, options) => {
    const hookEventName =
      input && typeof input === 'object' && 'hook_event_name' in input
        ? String((input as Record<string, unknown>).hook_event_name)
        : 'unknown';

    // Fast-path: already aborted before we even spawn
    if (options.signal.aborted) return {};

    return new Promise<HookJSONOutput>((resolve) => {
      const child = execFile(
        '/bin/sh',
        ['-c', command],
        { cwd, timeout: timeoutMs },
        (err, stdout) => {
          if (err) {
            log.warn(`hook command failed: ${command}`, { error: err.message });
            resolve({});
            return;
          }

          const trimmed = stdout.trim();
          if (!trimmed) {
            resolve({});
            return;
          }

          try {
            const parsed = JSON.parse(trimmed);
            resolve(mapHookOutput(parsed, hookEventName));
          } catch {
            log.warn(`hook output is not valid JSON: ${command}`);
            resolve({});
          }
        },
      );

      // Kill child if the session is aborted
      options.signal.addEventListener('abort', () => child.kill(), { once: true });

      // Pipe hook input to stdin (skip if already aborted)
      if (!options.signal.aborted && child.stdin) {
        const stdinPayload = JSON.stringify(input);
        child.stdin.on('error', () => {}); // Ignore EPIPE from killed process
        child.stdin.write(stdinPayload, () => {
          child.stdin?.end();
        });
      }
    });
  };
}

/**
 * Load project hooks from .claude/settings.json and convert to SDK format.
 * Returns undefined if no hooks are defined.
 */
export function loadProjectHooks(
  cwd: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  const raw = parseSettingsHooks(settingsPath);
  if (!raw) return undefined;

  const env: Record<string, string> = {
    CLAUDE_PROJECT_DIR: cwd,
    ...(process.env as Record<string, string>),
  };

  const result: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  let hasHooks = false;

  for (const [eventName, matchers] of Object.entries(raw)) {
    if (!Array.isArray(matchers)) continue;

    const sdkMatchers: HookCallbackMatcher[] = [];

    for (const matcher of matchers) {
      if (!Array.isArray(matcher.hooks)) continue;

      const callbacks = matcher.hooks
        .filter((h) => h.type === 'command' && h.command)
        .map((h) => {
          const expanded = expandEnvVars(h.command, env);
          const timeoutMs = (matcher.timeout ?? 60) * 1000;
          return createCommandCallback(expanded, cwd, timeoutMs);
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
