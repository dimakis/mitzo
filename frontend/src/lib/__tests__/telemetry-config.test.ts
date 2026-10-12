import { describe, expect, it } from 'vitest';
import { browserTelemetryConfig } from '../telemetry-config';

describe('browser telemetry destination', () => {
  it('uses the authenticated API relay on iOS and reads the current token for each export', () => {
    let token: string | null = 'first';
    const config = browserTelemetryConfig('api', 'https://mitzo.example:3100', () => token)!;
    expect(config.url).toBe('https://mitzo.example:3100/api/telemetry/v1/traces');
    expect(config.headers!()).toEqual({ Authorization: 'Bearer first' });
    token = 'second';
    expect(config.headers!()).toEqual({ Authorization: 'Bearer second' });
    token = null;
    expect(config.headers!()).toEqual({});
  });

  it('supports same-origin cookie export and keeps direct collectors free of Mitzo tokens', () => {
    expect(browserTelemetryConfig('api', '', () => null)?.url).toBe('/api/telemetry/v1/traces');
    const direct = browserTelemetryConfig('http://localhost:4318/', '', () => 'secret')!;
    expect(direct.url).toBe('http://localhost:4318/v1/traces');
    expect(direct.headers).toBeUndefined();
    expect(browserTelemetryConfig(undefined, '', () => 'secret')).toBeNull();
  });
});
