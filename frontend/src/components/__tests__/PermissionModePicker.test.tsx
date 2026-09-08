// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PermissionModePicker } from '../PermissionModePicker';

afterEach(cleanup);

describe('PermissionModePicker', () => {
  it('explains permission presets and displays only the confirmed mode', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PermissionModePicker mode="agent" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ask' }).getAttribute('title')).toContain(
      'Read-only',
    );
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('title')).toContain(
      'commands ask',
    );
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('title')).toContain(
      'commands allowed',
    );
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain(
      'Workspace limits apply',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(onChange).toHaveBeenCalledWith('auto');
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<PermissionModePicker mode="auto" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('true');
  });
});
