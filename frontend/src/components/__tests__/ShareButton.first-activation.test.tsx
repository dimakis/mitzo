// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, screen, waitFor } from '@testing-library/react';
import { ShareButton } from '../ShareButton';
import { installDialogStub } from './dialog-stub';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let observer: MutationObserver | undefined;

afterEach(async () => {
  observer?.disconnect();
  await act(async () => root?.unmount());
  host?.remove();
});

it('retains the first activation of a newly committed saved-file control', async () => {
  installDialogStub();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const open = vi.fn();
  let trigger: HTMLButtonElement | undefined;
  // A native event after commit may precede passive effects. Do not let a
  // render/fireEvent act wrapper initialize the control before this first event.
  const activated = new Promise<void>((resolve) => {
    observer = new MutationObserver(() => {
      const button = host!.querySelector<HTMLButtonElement>('button[aria-label="File options"]');
      if (!button) return;
      observer!.disconnect();
      trigger = button;
      button.click();
      resolve();
    });
    observer.observe(host!, { childList: true, subtree: true });
  });
  root.render(
    <ShareButton filePath={`/api/telos/artifacts/${'a'.repeat(32)}?revision=4`} onOpen={open} />,
  );
  await activated;
  expect(document.activeElement).toBe(trigger);
  await waitFor(() => {
    expect(trigger!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Open', exact: true })).toBeTruthy();
  });
  expect(host.querySelector('button[aria-label="File options"]')).toBe(trigger);
  await act(async () => screen.getByRole('button', { name: 'Open', exact: true }).click());
  expect(open).toHaveBeenCalledOnce();
});
