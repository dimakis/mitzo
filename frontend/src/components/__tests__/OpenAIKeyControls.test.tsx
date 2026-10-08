// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIKeyControls } from '../OpenAIKeyControls';
import * as api from '../../lib/connections-api';
const initial = {
  accountId: 'work',
  label: 'Work OpenAI API',
  health: 'not_verified',
  revision: 'v1',
  canSynchronize: true,
  errorCode: null,
  verifiedAt: null,
};
vi.mock('../../lib/connections-api', () => ({
  getOpenAIKeyStatus: vi.fn(async () => [initial]),
  replaceOpenAIKey: vi.fn(),
  synchronizeOpenAIKey: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getOpenAIKeyStatus).mockResolvedValue([initial as never]);
});
async function mount(authorized = true) {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const onReauthorizationNeeded = vi.fn();
  await act(async () =>
    root.render(
      <OpenAIKeyControls
        csrf="csrf"
        authorized={authorized}
        onReauthorizationNeeded={onReauthorizationNeeded}
      />,
    ),
  );
  return {
    node,
    root,
    onReauthorizationNeeded,
    button: (text: string) =>
      [...node.querySelectorAll('button')].find((b) => b.textContent === text)!,
  };
}
it('requires reauthorization before accepting a replacement key', async () => {
  const f = await mount(false);
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    expect(f.onReauthorizationNeeded).toHaveBeenCalledOnce();
    expect(f.node.querySelector('input[type=password]')).toBeNull();
    expect(api.replaceOpenAIKey).not.toHaveBeenCalled();
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('submits a masked key once, clears it before awaiting the response, and shows partial failure', async () => {
  const f = await mount();
  let resolve!: (value: never) => void;
  vi.mocked(api.replaceOpenAIKey).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    const input = f.node.querySelector<HTMLInputElement>('input[type=password]')!;
    const confirmed = f.node.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    await act(async () => fireEvent.change(input, { target: { value: 'PRIVATE_KEY' } }));
    expect(f.button('Validate and save').disabled).toBe(true);
    await act(async () => fireEvent.click(confirmed));
    await act(async () => fireEvent.click(f.button('Validate and save')));
    expect(api.replaceOpenAIKey).toHaveBeenCalledWith({
      accountId: 'work',
      revision: 'v1',
      apiKey: 'PRIVATE_KEY',
      sameProject: true,
      csrf: 'csrf',
    });
    expect(f.node.querySelector('input[type=password]')).toBeNull();
    expect(f.node.textContent).not.toContain('PRIVATE_KEY');
    await act(async () =>
      resolve({ ...initial, health: 'needs_attention', errorCode: 'SYNC_PENDING' } as never),
    );
    expect(f.node.textContent).toContain('Synchronization needs attention');
    expect(f.node.textContent).not.toContain('Credentials synchronized');
    expect(f.button('Retry synchronization')).toBeTruthy();
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('keeps native or upstream error text out of the credential form and refreshes actual status', async () => {
  const f = await mount();
  vi.mocked(api.synchronizeOpenAIKey).mockRejectedValueOnce(new Error('PRIVATE_KEY from upstream'));
  try {
    await act(async () => fireEvent.click(f.button('Synchronize saved key')));
    await act(async () => fireEvent.click(f.node.querySelector('input[type=checkbox]')!));
    await act(async () => fireEvent.click(f.button('Validate and synchronize')));
    expect(f.node.textContent).not.toContain('PRIVATE_KEY');
    expect(f.node.textContent).toContain('Could not confirm');
    expect(api.getOpenAIKeyStatus).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => f.root.unmount());
  }
});
