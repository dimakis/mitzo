import { describe, it, expect } from 'vitest';
import { notificationFields } from '../apns.js';
describe('native notification contract', () => {
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
