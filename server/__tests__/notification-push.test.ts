import { describe, it, expect } from 'vitest';
import { notificationFields, badgeFields } from '../apns.js';
describe('native notification contract', () => {
  it('clears badges using the alert push type required for badge payloads', () => {
    expect(badgeFields(0)).toMatchObject({ badge: 0, pushType: 'alert', priority: 10 });
    expect(badgeFields(0)).not.toHaveProperty('sound');
    expect(badgeFields(0)).not.toHaveProperty('alert');
  });
  it('uses the authoritative needs-you count including zero and notification deep links', () => {
    const fields = notificationFields({
      title: 'Mitzo',
      body: 'Review',
      badge: 0,
      category: 'SESSION_PERMISSION',
      threadId: 's1',
      data: { notificationId: 'permission:p1', sessionId: 's1' },
    });
    expect(fields.badge).toBe(0);
    expect(fields.category).toBe('SESSION_PERMISSION');
    expect(fields.payload.notificationId).toBe('permission:p1');
    expect(fields.threadId).toBe('s1');
  });
});
