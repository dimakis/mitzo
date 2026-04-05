/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { createElement, act } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SlashPicker, type SkillEntry } from '../SlashPicker';

const mockSkills: SkillEntry[] = [
  { name: 'simplify', description: 'Simplify code', scope: 'bundled' },
  { name: 'deploy', description: 'Deploy the app', scope: 'repo' },
  {
    name: 'review',
    description: 'Review code',
    scope: 'user',
    collisions: [{ scope: 'bundled', description: 'Bundled review' }],
  },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockSkills),
    }),
  );
});

afterEach(() => {
  cleanup();
});

async function renderPicker(props: Partial<Parameters<typeof SlashPicker>[0]> = {}) {
  const defaults = { query: '/', onSelect: vi.fn(), onClose: vi.fn() };
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(createElement(SlashPicker, { ...defaults, ...props }));
  });
  return result!;
}

describe('SlashPicker', () => {
  it('renders all skills after loading', async () => {
    await renderPicker();
    expect(screen.getByText('/simplify')).toBeTruthy();
    expect(screen.getByText('/deploy')).toBeTruthy();
    expect(screen.getByText('/review')).toBeTruthy();
  });

  it('filters skills by typed prefix', async () => {
    await renderPicker({ query: '/sim' });
    expect(screen.getByText('/simplify')).toBeTruthy();
    expect(screen.queryByText('/deploy')).toBeNull();
    expect(screen.queryByText('/review')).toBeNull();
  });

  it('shows collision badge for skills with collisions', async () => {
    await renderPicker();
    expect(screen.getByText('also in: bundled')).toBeTruthy();
  });

  it('sorts by scope: repo > user > bundled', async () => {
    await renderPicker();
    const items = screen.getAllByRole('button');
    expect(items).toHaveLength(3);
    // repo (deploy) first, then user (review), then bundled (simplify)
    expect(items[0].textContent).toContain('deploy');
    expect(items[1].textContent).toContain('review');
    expect(items[2].textContent).toContain('simplify');
  });

  it('calls onSelect when a skill is clicked', async () => {
    const onSelect = vi.fn();
    await renderPicker({ onSelect });

    const user = userEvent.setup();
    const deployButton = screen.getByText('/deploy').closest('button')!;
    await user.click(deployButton);

    expect(onSelect).toHaveBeenCalledWith('deploy');
  });

  it('shows empty message when no skills match filter', async () => {
    await renderPicker({ query: '/zzz' });
    expect(screen.getByText('No commands matching "/zzz"')).toBeTruthy();
  });

  it('passes cwd to fetch', async () => {
    await renderPicker({ cwd: '/some/repo' });
    expect((fetch as Mock).mock.calls[0][0]).toContain('cwd=%2Fsome%2Frepo');
  });

  it('exports SkillEntry type', () => {
    const entry: SkillEntry = {
      name: 'test',
      description: 'A test',
      scope: 'bundled',
    };
    expect(entry.name).toBe('test');
  });
});
