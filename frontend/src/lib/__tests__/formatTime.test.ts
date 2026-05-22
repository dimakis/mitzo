import { describe, it, expect } from 'vitest';
import { formatMessageTime } from '../formatTime';

describe('formatMessageTime', () => {
  it('formats a morning timestamp', () => {
    // 2026-01-15 09:30:00 local time
    const ts = new Date(2026, 0, 15, 9, 30, 0).getTime();
    const result = formatMessageTime(ts);
    expect(result).toMatch(/9:30\s*AM/i);
  });

  it('formats an afternoon timestamp', () => {
    const ts = new Date(2026, 0, 15, 14, 5, 0).getTime();
    const result = formatMessageTime(ts);
    expect(result).toMatch(/2:05\s*PM/i);
  });

  it('formats midnight as 12:00 AM', () => {
    const ts = new Date(2026, 0, 15, 0, 0, 0).getTime();
    const result = formatMessageTime(ts);
    expect(result).toMatch(/12:00\s*AM/i);
  });
});
