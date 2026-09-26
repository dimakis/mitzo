import { isAbsolute } from 'node:path';

/** Non-secret host paths only. Safe to retain with durable attempt routing. */
export type OpenShellCliEnvironment = Readonly<
  Partial<Record<'HOME' | 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME' | 'XDG_CACHE_HOME' | 'PATH', string>>
>;
const keys = new Set(['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH']);

export function validateOpenShellCliEnvironment(
  value: OpenShellCliEnvironment,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid private OpenShell CLI environment');
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !keys.has(key) ||
      typeof entry !== 'string' ||
      !entry ||
      /[\r\n\0]/.test(entry) ||
      (key !== 'PATH' && !isAbsolute(entry))
    )
      throw new Error('Invalid private OpenShell CLI environment');
    result[key] = entry;
  }
  if (!result.HOME || !result.XDG_CONFIG_HOME || !result.PATH)
    throw new Error('Private OpenShell CLI environment requires explicit home, config and path');
  return result;
}
