/** App authentication/configuration is distinct from the retained provider host.
 * Do not spread process.env: dotenv is disabled in the supervised child too. */
export function custodianAppEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER: '1',
    DOTENV_CONFIG_PATH: '/dev/null',
  };
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'TZ',
    'NODE_ENV',
    'REPO_PATH',
    'PORT',
    'MITZO_BIND_HOST',
    'AUTH_PASSPHRASE',
    'AUTH_SECRET',
    'COOKIE_MAX_AGE_HOURS',
    'CORS_ALLOWED_ORIGINS',
    'MITZO_CODEX_PRIVATE_DIR',
    'LOG_LEVEL',
  ])
    if (source[name] !== undefined) result[name] = source[name];
  return result;
}
