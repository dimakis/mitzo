/** Podman preserves the gateway's empty DriverSandbox namespace. Empty must be
 * explicit: it is an exact driver label value, never a wildcard or default. */
export function isPodmanSandboxNamespace(value: unknown): value is string {
  return (
    typeof value === 'string' && (value === '' || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))
  );
}
