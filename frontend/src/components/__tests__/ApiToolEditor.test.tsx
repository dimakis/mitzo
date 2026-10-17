// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiToolEditor } from '../ApiToolEditor';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../../lib/credential-connections-api', () => ({
  getCachedCredentialAuthorization: () => ({ csrf: 'fixture', expiresAt: Date.now() + 60_000 }),
  reauthorizeKeychain: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const draft = {
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  configuration: {
    template: 'home-assistant.state@1',
    label: 'Office',
    connectionId: 'fixture',
    entityId: 'sensor.office',
  },
  verified: true,
};
const inventory = {
  templates: [
    {
      id: 'home-assistant.state@1',
      label: 'Home Assistant entity state',
      description: 'Read one state.',
      method: 'GET',
      path: '/api/states/{entityId}',
      source: 'server/api-tool-template.ts',
      implementation: 'home-assistant-state-v1',
      documentation: 'https://example.test',
      output: ['entity_id', 'state', 'last_changed'],
    },
  ],
  drafts: [draft],
  connections: [{ id: 'fixture', label: 'Fixture', endpoint: 'https://ha.example.com' }],
};
function withoutAbortHelpers(removeTimeout = false) {
  const descriptors = ['any', ...(removeTimeout ? ['timeout'] : [])].map(
    (name) => [name, Object.getOwnPropertyDescriptor(AbortSignal, name)] as const,
  );
  for (const [name] of descriptors)
    Object.defineProperty(AbortSignal, name, {
      configurable: true,
      writable: true,
      value: undefined,
    });
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(AbortSignal, name, descriptor);
      else Reflect.deleteProperty(AbortSignal, name);
    }
  };
}
it.each([false, true])(
  'loads the inventory without AbortSignal.any (also missing timeout: %s)',
  async (removeTimeout) => {
    const restore = withoutAbortHelpers(removeTimeout);
    try {
      vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => inventory } as Response);
      render(<ApiToolEditor onPublished={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Configure API tool' }));
      await screen.findByRole('combobox', { name: 'Saved API draft' });
      expect(apiFetch).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      restore();
    }
  },
);
it.each(['native', 'legacy'] as const)(
  'cancels verification and keeps publication disabled with %s abort APIs',
  async (mode) => {
    const restore = mode === 'legacy' ? withoutAbortHelpers() : () => {};
    let signal: AbortSignal | undefined;
    const published = vi.fn();
    try {
      vi.mocked(apiFetch).mockImplementation(async (path, init) => {
        if (String(path).endsWith('/verify')) {
          signal = init!.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) =>
            signal!.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            ),
          );
        }
        return { ok: true, json: async () => inventory } as Response;
      });
      render(<ApiToolEditor onPublished={published} />);
      fireEvent.click(screen.getByRole('button', { name: 'Configure API tool' }));
      fireEvent.change(await screen.findByRole('combobox', { name: 'Saved API draft' }), {
        target: { value: draft.id },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Verify API read' }));
      await screen.findByRole('button', { name: 'Cancel verification' });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel verification' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/cancelled/));
      expect(signal!.aborted).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Publish tool' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(published).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  },
);
