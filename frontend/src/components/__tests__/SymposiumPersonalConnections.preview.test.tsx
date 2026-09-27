// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPersonalConnections } from '../SymposiumPersonalConnections';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it('keeps device ownership through callback recovery and supports a second fixture code', async () => {
  const upstream = vi.fn(() => Promise.reject(new Error('No network')));
  vi.stubGlobal('fetch', upstream);
  await import('../../preview/network');
  vi.mocked(apiFetch).mockImplementation((url, init) => window.fetch(url, init));
  render(<SymposiumPersonalConnections />);
  await screen.findByText('research@example.test');
  const research = within(screen.getByRole('region', { name: 'Research' }));
  const personal = within(screen.getByRole('region', { name: 'Personal' }));
  fireEvent.click(research.getByRole('button', { name: 'Connect' }));
  fireEvent.click(await research.findByRole('button', { name: 'Get sign-in code' }));
  await research.findByRole('button', { name: 'Cancel sign-in' });
  const first = await (
    await window.fetch('/api/symposium/personal/login/status?connectionId=preview-research')
  ).json();
  fireEvent.click(research.getByRole('button', { name: 'Recover callback sign-in' }));
  await research.findByText(/Continue or cancel it in device sign-in/);
  expect((personal.getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(research.getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() =>
    expect(
      (research.getByRole('button', { name: 'Get sign-in code' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100));
  });
  expect(
    (research.getByRole('button', { name: 'Get sign-in code' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.click(research.getByRole('button', { name: 'Get sign-in code' }));
  await research.findByRole('button', { name: 'Cancel sign-in' });
  const second = await (
    await window.fetch('/api/symposium/personal/login/status?connectionId=preview-research')
  ).json();
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(second).toMatchObject({ state: 'pending', userCode: 'DEMO-CODE' });
  expect(research.getByText(second.userCode)).toBeTruthy();
  expect(upstream).not.toHaveBeenCalled();
});
