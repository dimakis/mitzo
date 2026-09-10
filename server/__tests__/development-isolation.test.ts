import { describe, expect, it } from 'vitest';
import { startupRepositoryMaintenanceEnabled } from '../development-isolation.js';

describe('development isolation', () => {
  it('disables repository maintenance only for an explicit non-production run', () => {
    expect(
      startupRepositoryMaintenanceEnabled({
        NODE_ENV: 'development',
        MITZO_DISABLE_REPO_MAINTENANCE: '1',
      }),
    ).toBe(false);
    expect(
      startupRepositoryMaintenanceEnabled({
        NODE_ENV: 'production',
        MITZO_DISABLE_REPO_MAINTENANCE: '1',
      }),
    ).toBe(true);
    expect(startupRepositoryMaintenanceEnabled({ NODE_ENV: 'development' })).toBe(true);
  });
});
