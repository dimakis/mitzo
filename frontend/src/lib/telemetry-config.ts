/** Mitzo credentials are supplied only to the fixed API relay, never a collector. */
export function browserTelemetryConfig(
  endpoint: string | undefined,
  apiBase: string,
  readToken: () => string | null,
): { url: string; headers?: () => Record<string, string> } | null {
  if (!endpoint) return null;
  if (endpoint === 'api') {
    return {
      url: `${apiBase.replace(/\/$/, '')}/api/telemetry/v1/traces`,
      headers: () => {
        try {
          const token = readToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        } catch {
          return {};
        }
      },
    };
  }
  return { url: `${endpoint.replace(/\/$/, '')}/v1/traces` };
}
