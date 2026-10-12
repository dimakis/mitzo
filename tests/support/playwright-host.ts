// Check before webServer/globalSetup: macOS browser registration aborts inside
// Codex's Seatbelt sandbox, producing a crash dialog for every attempted launch.
export function assertPlaywrightHost(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  args = process.argv,
): void {
  if (args.some((arg) => ['--list', '--help', '-h'].includes(arg))) return;
  if (platform !== 'darwin' || env.CODEX_SANDBOX !== 'seatbelt') return;
  throw new Error(
    'Mitzo Playwright tests cannot launch browsers inside the Codex macOS Seatbelt sandbox. ' +
      'Run the same test command outside the sandbox through the approved execution tool ' +
      'or in a normal terminal. Do not retry here or unset CODEX_SANDBOX: macOS denies ' +
      'browser process registration and each attempt can produce a crash popup. ' +
      'Use --list to inspect tests without launching browsers.',
  );
}
