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
vi.mock('../../lib/connections-api', async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  authorizeOpenAIKey: vi.fn(),
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
    await act(async () => fireEvent.change(input, { target: { value: 'PRIVATE_KEY' } }));
    expect(f.button('Save API key').disabled).toBe(false);
    expect(f.node.querySelector('input[type=checkbox]')).toBeNull();
    expect(f.node.textContent).toContain('OpenAI bills the account associated with this key');
    await act(async () => fireEvent.click(f.button('Save API key')));
    expect(api.replaceOpenAIKey).toHaveBeenCalledWith({
      accountId: 'work',
      revision: 'v1',
      apiKey: 'PRIVATE_KEY',
      csrf: 'csrf',
    });
    expect(f.node.querySelector('input[type=password]')).toBeNull();
    expect(f.node.textContent).not.toContain('PRIVATE_KEY');
    await act(async () =>
      resolve({
        ...initial,
        revision: 'v2',
        health: 'needs_attention',
        errorCode: 'CHAT_UPDATE_UNCONFIRMED',
      } as never),
    );
    expect(f.node.textContent).toContain('Key update incomplete');
    expect(f.node.textContent).not.toContain('Ready to use');
    expect(f.button('Finish key update')).toBeTruthy();
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('keeps native or upstream error text out of the credential form and refreshes actual status', async () => {
  vi.mocked(api.getOpenAIKeyStatus).mockResolvedValue([
    { ...initial, health: 'needs_attention' } as never,
  ]);
  const f = await mount();
  vi.mocked(api.synchronizeOpenAIKey).mockRejectedValueOnce(new Error('PRIVATE_KEY from upstream'));
  try {
    await act(async () => fireEvent.click(f.button('Finish key update')));
    await act(async () => fireEvent.click(f.button('Finish update')));
    expect(f.node.textContent).not.toContain('PRIVATE_KEY');
    expect(f.node.textContent).toContain('Could not confirm');
    expect(api.getOpenAIKeyStatus).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => f.root.unmount());
  }
});

it('keeps replacement actionable when Keychain access needs explicit authorization and does not prompt on mount', async () => {
  vi.mocked(api.getOpenAIKeyStatus).mockResolvedValue([
    {
      ...initial,
      health: 'unavailable',
      canSynchronize: false,
      errorCode: 'KEYCHAIN_AUTHORIZATION_REQUIRED',
    } as never,
  ]);
  const f = await mount(false);
  try {
    expect(f.node.textContent).toContain('Keychain access needs approval');
    expect(f.button('Replace API key').disabled).toBe(false);
    expect(api.authorizeOpenAIKey).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(f.button('Replace API key')));
    expect(f.onReauthorizationNeeded).toHaveBeenCalledOnce();
    expect(api.authorizeOpenAIKey).not.toHaveBeenCalled();
    expect(f.node.querySelector('input[type=password]')).toBeNull();
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('authorizes the signed helper only after an explicit authorized replacement click', async () => {
  vi.mocked(api.getOpenAIKeyStatus).mockResolvedValue([
    {
      ...initial,
      health: 'unavailable',
      canSynchronize: false,
      errorCode: 'KEYCHAIN_AUTHORIZATION_REQUIRED',
    } as never,
  ]);
  vi.mocked(api.authorizeOpenAIKey).mockResolvedValue(initial as never);
  const f = await mount(true);
  try {
    expect(api.authorizeOpenAIKey).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(f.button('Replace API key')));
    expect(api.authorizeOpenAIKey).toHaveBeenCalledExactlyOnceWith({
      accountId: 'work',
      revision: 'v1',
      csrf: 'csrf',
    });
    expect(api.replaceOpenAIKey).not.toHaveBeenCalled();
    expect(f.node.querySelector('input[type=password]')).not.toBeNull();
  } finally {
    await act(async () => f.root.unmount());
  }
});

it('shows refresh progress, retains the last account on failure, and blocks edits to stale status', async () => {
  const f = await mount();
  let reject!: (error: Error) => void;
  vi.mocked(api.getOpenAIKeyStatus).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  try {
    expect(f.node.textContent).not.toContain('Finish key update');
    await act(async () => fireEvent.click(f.button('Refresh status')));
    expect(f.button('Checking…').disabled).toBe(true);
    expect(f.node.textContent).toContain('Checking saved account status');
    await act(async () => reject(new Error('PRIVATE_UPSTREAM_TEXT')));
    expect(f.node.textContent).toContain('Work OpenAI API');
    expect(f.node.textContent).toContain('out of date');
    expect(f.button('Replace API key').disabled).toBe(true);
    expect(f.node.textContent).not.toContain('PRIVATE_UPSTREAM_TEXT');
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('keeps update feedback after a new revision arrives and after refreshing that revision', async () => {
  const updated = {
    ...initial,
    revision: 'v2',
    health: 'needs_attention',
    errorCode: 'CHAT_UPDATE_UNCONFIRMED',
  };
  vi.mocked(api.replaceOpenAIKey).mockResolvedValue(updated as never);
  const f = await mount();
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    await act(async () =>
      fireEvent.change(f.node.querySelector('input[type=password]')!, {
        target: { value: 'SYNTHETIC_KEY' },
      }),
    );
    await act(async () => fireEvent.click(f.button('Save API key')));
    expect(f.node.textContent).toContain('key is saved on this Mac');
    vi.mocked(api.getOpenAIKeyStatus).mockResolvedValue([updated as never]);
    await act(async () => fireEvent.click(f.button('Refresh status')));
    expect(f.node.textContent).toContain('key is saved on this Mac');
    expect(f.node.textContent).toContain('Status refreshed at');
  } finally {
    await act(async () => f.root.unmount());
  }
});
it('continues the explicitly requested replacement after browser reauthorization', async () => {
  const f = await mount(false);
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    await act(async () =>
      f.root.render(
        <OpenAIKeyControls
          csrf="new-csrf"
          authorized
          onReauthorizationNeeded={f.onReauthorizationNeeded}
        />,
      ),
    );
    expect(f.node.querySelector('input[type=password]')).not.toBeNull();
    expect(api.authorizeOpenAIKey).not.toHaveBeenCalled();
    expect(api.replaceOpenAIKey).not.toHaveBeenCalled();
  } finally {
    await act(async () => f.root.unmount());
  }
});

it('does not report successful replacement when only the previous key remains ready', async () => {
  const f = await mount();
  vi.mocked(api.replaceOpenAIKey).mockResolvedValue({
    ...initial,
    revision: 'v2',
    health: 'ready',
    errorCode: 'CHAT_PAUSE_FAILED',
  } as never);
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    await act(async () =>
      fireEvent.change(f.node.querySelector('input[type=password]')!, {
        target: { value: 'SYNTHETIC_KEY' },
      }),
    );
    await act(async () => fireEvent.click(f.button('Save API key')));
    expect(f.node.textContent).toContain('replacement was not saved');
    expect(f.node.textContent).not.toContain('API key updated.');
  } finally {
    await act(async () => f.root.unmount());
  }
});

it('hides previous failure during a save and stops save progress before refreshing an uncertain result', async () => {
  vi.mocked(api.getOpenAIKeyStatus).mockResolvedValueOnce([
    { ...initial, errorCode: 'NOT_APPLIED' } as never,
  ]);
  const f = await mount();
  let rejectSave!: (error: Error) => void;
  let completeRefresh!: (value: never) => void;
  vi.mocked(api.replaceOpenAIKey).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectSave = reject;
      }),
  );
  vi.mocked(api.getOpenAIKeyStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeRefresh = resolve;
      }),
  );
  try {
    await act(async () => fireEvent.click(f.button('Replace API key')));
    await act(async () =>
      fireEvent.change(f.node.querySelector('input[type=password]')!, {
        target: { value: 'SYNTHETIC_KEY' },
      }),
    );
    const saving = act(async () => fireEvent.click(f.button('Save API key')));
    await saving;
    expect(f.node.textContent).not.toContain('previous update did not save');
    expect(f.node.textContent).not.toContain('Status refreshed at');
    expect(f.button('Refresh status').disabled).toBe(true);
    await act(async () => rejectSave(new Error('request timed out')));
    expect(f.node.textContent).not.toContain('Checking the key and updating');
    expect(f.node.textContent).toContain('Checking saved account status');
    await act(async () =>
      completeRefresh([{ ...initial, revision: 'v2', errorCode: 'CHAT_PAUSE_FAILED' }] as never),
    );
    expect(f.node.textContent).toContain('replacement was not saved');
    expect(f.node.textContent).not.toContain('may already have been saved');
  } finally {
    await act(async () => f.root.unmount());
  }
});
