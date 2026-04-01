import { describe, it, expect } from 'vitest';
import { isConfigured } from '../notify.js';

describe('notify module', () => {
  it('isConfigured returns false without NTFY_TOPIC', () => {
    expect(isConfigured()).toBe(false);
  });
});
