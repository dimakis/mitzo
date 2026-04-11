import { describe, it, expect } from 'vitest';
import { sourceIcon } from '../todo-utils';

describe('sourceIcon', () => {
  it('returns GH for github', () => {
    expect(sourceIcon('github')).toBe('GH');
  });

  it('returns JR for jira', () => {
    expect(sourceIcon('jira')).toBe('JR');
  });

  it('returns GM for gmail', () => {
    expect(sourceIcon('gmail')).toBe('GM');
  });

  it('returns GD for gdocs', () => {
    expect(sourceIcon('gdocs')).toBe('GD');
  });

  it('returns first two chars uppercased for unknown types', () => {
    expect(sourceIcon('slack')).toBe('SL');
    expect(sourceIcon('confluence')).toBe('CO');
  });
});
