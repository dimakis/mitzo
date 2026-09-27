import { randomBytes } from 'node:crypto';
/** App authentication/configuration is distinct from the retained provider host.
 * Do not spread process.env: dotenv is disabled in the supervised child too. */
export function custodianAppEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER: '1',
    DOTENV_CONFIG_PATH: '/dev/null',
    AUTH_SECRET: randomBytes(32).toString('hex'),
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
    'MITZO_DISABLE_REPO_MAINTENANCE',
    'MITZO_REPO_PATH_CEILING',
    'MITZO_WORKTREE_CLEANUP_POLICY',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'MITZO_ACCOUNT_PROFILES_FILE',
    'MITZO_CODEX_ENABLED',
    // Explicit ordinary-runtime settings only; retained Symposium management
    // credentials and owned-host configuration never enter the app child.
    'MITZO_OPENSHELL_ENABLED',
    'MITZO_OPENSHELL_PROVIDERS',
    'MITZO_OPENSHELL_LIFECYCLE_ENABLED',
    'MITZO_OPENSHELL_RETENTION_DAYS',
    'MITZO_OPENSHELL_IDLE_MINUTES',
    'MITZO_OPENSHELL_RECONCILE_MINUTES',
    'MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES',
    'MITZO_OPENSHELL_SANDBOX_THRESHOLD',
    'MITZO_OPENSHELL_IMAGE',
    'MITZO_OPENSHELL_POLICY',
    'MITZO_OPENSHELL_SEED',
    'MITZO_OPENSHELL_CLI',
    'MITZO_OPENSHELL_SERVICE_PROVIDERS',
    'MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS',
    'MITZO_OPENSHELL_WEB_SEARCH',
    'MITZO_OPENSHELL_GATEWAY_ENDPOINT',
    'MITZO_OPENSHELL_GATEWAY_INSECURE',
    'MITZO_OPENSHELL_CREATE_DETACHED',
    'MITZO_OPENSHELL_SANDBOX_ID_LENGTH',
    'MITZO_OPENSHELL_OPENAI_API_ENABLED',
    'MITZO_OPENSHELL_SANDBOX_NAME',
    'OPENSHELL_WORKSPACE',
    'OPENSHELL_GATEWAY',

    'MITZO_URL',
    'AUTH_PASSPHRASE',
    'COOKIE_MAX_AGE_HOURS',
    'CORS_ALLOWED_ORIGINS',
    'MITZO_CODEX_PRIVATE_DIR',
    'LOG_LEVEL',
  ])
    if (source[name] !== undefined) result[name] = source[name];
  return result;
}
