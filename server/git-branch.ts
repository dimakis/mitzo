import { spawnSync } from 'node:child_process';

/** Git branch syntax, with expression expansion excluded before invoking Git. */
export function isGitBranchName(value: string): boolean {
  if (!value || value.startsWith('-') || value.includes('@{') || value.includes('\0')) return false;
  const result = spawnSync('git', ['check-ref-format', '--branch', value], {
    env: {
      PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    timeout: 5000,
    stdio: 'ignore',
  });
  return result.status === 0;
}
