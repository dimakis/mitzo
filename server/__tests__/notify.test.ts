import { describe, it, expect } from 'vitest';
import { isConfigured, buildNotificationHeaders } from '../notify.js';

describe('notify module', () => {
  it('isConfigured returns false without NTFY_TOPIC', () => {
    expect(isConfigured()).toBe(false);
  });

  it('buildNotificationHeaders includes tool name in title', () => {
    const headers = buildNotificationHeaders('Bash');
    expect(headers.title).toBe('Mitzo: Bash');
    expect(headers.priority).toBe('4');
    expect(headers.tags).toBe('robot');
  });

  it('buildNotificationHeaders handles different tool names', () => {
    expect(buildNotificationHeaders('Edit').title).toBe('Mitzo: Edit');
    expect(buildNotificationHeaders('Write').title).toBe('Mitzo: Write');
  });
});
