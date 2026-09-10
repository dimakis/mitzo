/** Repository maintenance can be disabled only for an explicit non-production
 * development run. Production ignores the escape hatch.
 */
export function startupRepositoryMaintenanceEnabled(env: NodeJS.ProcessEnv = process.env) {
  return !(env.NODE_ENV !== 'production' && env.MITZO_DISABLE_REPO_MAINTENANCE === '1');
}
