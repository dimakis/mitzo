import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { OwnedReleasePlan } from './symposium-owned-release.js';

/** Fresh launcher environment shared by ordinary owned and registered staging launchers. */
export function ownedCustodianEnvironment(
  plan: OwnedReleasePlan,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (
    source.NODE_OPTIONS ||
    source.NODE_PATH ||
    (source.DOTENV_CONFIG_PATH && source.DOTENV_CONFIG_PATH !== '/dev/null') ||
    !source.AUTH_PASSPHRASE ||
    source.AUTH_PASSPHRASE.length < 32 ||
    !source.AUTH_SECRET ||
    source.AUTH_SECRET.length < 64 ||
    !/^[0-9]{4,5}$/.test(source.PORT ?? '') ||
    Number(source.PORT) < 1024 ||
    Number(source.PORT) > 65535 ||
    !['127.0.0.1', '::1'].includes(source.MITZO_BIND_HOST ?? '')
  )
    throw Error('Owned launch environment refused');
  return {
    PATH: '/usr/bin:/bin',
    AUTH_PASSPHRASE: source.AUTH_PASSPHRASE,
    AUTH_SECRET: source.AUTH_SECRET,
    PORT: source.PORT,
    MITZO_BIND_HOST: source.MITZO_BIND_HOST,
    DOTENV_CONFIG_PATH: '/dev/null',
    MITZO_CODEX_ENABLED: '1',
    NODE_ENV: 'production',
    HOME: plan.appHome,
    XDG_CONFIG_HOME: join(plan.appHome, '.config'),
    XDG_STATE_HOME: join(plan.appHome, '.local', 'state'),
    XDG_CACHE_HOME: join(plan.appHome, '.cache'),
    MITZO_SYMPOSIUM_OWNED_HOST_CONFIG: plan.configPath,
    REPO_PATH: plan.repositoryPath,
    MITZO_REPO_PATH_CEILING: plan.repositoryPath,
    MITZO_DISABLE_REPO_MAINTENANCE: '1',
    MITZO_WORKTREE_CLEANUP_POLICY: 'report',
    MITZO_CODEX_PRIVATE_DIR: join(plan.repositoryPath, '.mitzo', 'codex-private'),
    MITZO_ACCOUNT_PROFILES_FILE: join(plan.planDirectory, 'empty-accounts.json'),
    MITZO_OPENSHELL_ENABLED: '0',
  };
}
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
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  ])
    if (source[name] !== undefined) result[name] = source[name];
  if (source.MITZO_SYMPOSIUM_CANONICAL_STAGE === '1') {
    Object.assign(result, {
      YAPPER_PROXY_TARGET: 'http://127.0.0.1:5191',
      CONTEXGIN_URL: 'http://127.0.0.1:5192',
      CENTAUR_URL: 'http://127.0.0.1:5193',
      MITZO_URL: 'http://127.0.0.1:3190',
    });
  }
  return result;
}
