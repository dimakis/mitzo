// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HomePinButton } from '../HomePinButton';
import { HomeDisplaySettings } from '../HomeDisplaySettings';
import { MinionNameSettings } from '../MinionNameSettings';
import type { HomePreferences } from '@mitzo/protocol';

const data = vi.hoisted(() => ({
  preferences: {
    revision: 0,
    names: { briefing: 'Minion', terminal: 'Minion' },
    pins: [],
    showDailyQuote: true,
  } as HomePreferences,
  conflict: false,
  fetch: vi.fn(),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => data.fetch(...args) }));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
beforeEach(() => {
  data.preferences = {
    revision: 0,
    names: { briefing: 'Minion', terminal: 'Minion' },
    pins: [],
    showDailyQuote: true,
  };
  data.conflict = false;
  data.fetch.mockReset().mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') {
      const patch = JSON.parse(String(options.body));
      if (data.conflict || patch.revision !== data.preferences.revision)
        return { ok: false, status: 409, json: async () => ({ error: 'changed' }) };
      data.preferences = { ...data.preferences, ...patch, revision: data.preferences.revision + 1 };
    }
    return { ok: true, json: async () => data.preferences };
  });
});
afterEach(cleanup);
describe('home preferences', () => {
  it.each(['names', 'pins'])(
    'requires explicit review before saving a dirty nickname draft after another device changes %s',
    async (change) => {
      render(<MinionNameSettings />);
      await waitFor(() =>
        expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
          'Minion',
        ),
      );
      fireEvent.change(screen.getByLabelText('Briefing minion name'), {
        target: { value: 'Jeeves' },
      });
      data.preferences = {
        ...data.preferences,
        revision: 1,
        ...(change === 'names'
          ? { names: { briefing: 'Brew', terminal: 'Alfred' } }
          : { pins: [{ kind: 'session' as const, id: 'new', title: 'New' }] }),
      };
      const remote = data.preferences;
      await act(async () => {
        window.dispatchEvent(new Event('mitzo-home-preferences-changed'));
      });
      expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
        'Jeeves',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save names' }));
      expect((await screen.findByRole('alert')).textContent).toContain('changed on another device');
      expect(data.preferences).toEqual(remote);
      expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
        'Jeeves',
      );
      expect(
        (screen.getByRole('button', { name: 'Save names' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.submit(screen.getByRole('button', { name: 'Save names' }).closest('form')!);
      expect(data.fetch.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
      const initialSave = data.fetch.mock.calls.find((call) => call[1]?.method === 'PUT')!;
      expect(JSON.parse(initialSave[1].body).revision).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Review current names' }));
      expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
        remote.names.briefing,
      );
      expect((screen.getByLabelText('Terminal minion name') as HTMLInputElement).value).toBe(
        remote.names.terminal,
      );
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.change(screen.getByLabelText('Briefing minion name'), {
        target: { value: 'Jeeves' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save names' }));
      await screen.findByText('Names saved.');
      expect(data.preferences.names).toEqual({
        briefing: 'Jeeves',
        terminal: remote.names.terminal,
      });
      expect(data.preferences.pins).toEqual(remote.pins);
      const finalSave = data.fetch.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)!;
      expect(JSON.parse(finalSave[1].body).revision).toBe(1);
    },
  );
  it('keeps a newer remote edit when the save response arrives after its refresh', async () => {
    const original = data.preferences;
    let reads = 0;
    let resolveSave!: (value: unknown) => void;
    data.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'PUT')
        return new Promise((resolve) => {
          resolveSave = resolve;
        });
      if (++reads > 2) return new Promise(() => {});
      return { ok: true, json: async () => data.preferences };
    });
    render(<HomePinButton pin={{ kind: 'session', id: 'session-1', title: 'Recovery' }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Pin to Today' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Today' }));
    data.preferences = { ...original, revision: 2, pins: [] };
    await act(async () => {
      window.dispatchEvent(new Event('mitzo-home-preferences-changed'));
    });
    await act(async () => {
      resolveSave({
        ok: true,
        json: async () => ({
          ...original,
          revision: 1,
          pins: [{ kind: 'session', id: 'session-1', title: 'Recovery' }],
        }),
      });
    });
    expect(screen.getByRole('button', { name: 'Pin to Today' })).toBeTruthy();
  });
  it('clears a load error after a successful explicit retry', async () => {
    data.fetch.mockResolvedValueOnce({ ok: false });
    render(<MinionNameSettings />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('preserves unsaved names when an unrelated pin refresh arrives', async () => {
    render(<MinionNameSettings />);
    await waitFor(() =>
      expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
        'Minion',
      ),
    );
    fireEvent.change(screen.getByLabelText('Briefing minion name'), {
      target: { value: 'Jeeves' },
    });
    data.preferences = {
      ...data.preferences,
      revision: 1,
      pins: [{ kind: 'session', id: 'new', title: 'New' }],
    };
    await act(async () => {
      window.dispatchEvent(new Event('mitzo-home-preferences-changed'));
    });
    expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
      'Jeeves',
    );
  });
  it('never applies a stale revision fetched after a successful save', async () => {
    const old = data.preferences;
    let reads = 0;
    data.fetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'PUT')
        return {
          ok: true,
          json: async () => ({
            ...old,
            revision: 1,
            pins: [{ kind: 'session', id: 'session-1', title: 'Recovery' }],
          }),
        };
      reads++;
      return { ok: true, json: async () => old };
    });
    render(<HomePinButton pin={{ kind: 'session', id: 'session-1', title: 'Recovery' }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Pin to Today' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Today' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole('button', { name: 'Unpin from Today' })).toBeTruthy();
  });
  it('rejects malformed successful responses before rendering pin controls', async () => {
    data.fetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<HomePinButton pin={{ kind: 'session', id: 'session-1', title: 'Recovery' }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load');
    expect(
      (screen.getByRole('button', { name: 'Pin to Today' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('saves separate briefing and terminal nicknames through the shared workspace API', async () => {
    render(<MinionNameSettings />);
    await waitFor(() =>
      expect((screen.getByLabelText('Briefing minion name') as HTMLInputElement).value).toBe(
        'Minion',
      ),
    );
    fireEvent.change(screen.getByLabelText('Briefing minion name'), {
      target: { value: 'Jeeves' },
    });
    fireEvent.change(screen.getByLabelText('Terminal minion name'), {
      target: { value: 'Alfred' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save names' }));
    await waitFor(() =>
      expect(data.preferences.names).toEqual({ briefing: 'Jeeves', terminal: 'Alfred' }),
    );
    expect(
      JSON.parse(data.fetch.mock.calls.find((call) => call[1]?.method === 'PUT')![1].body).revision,
    ).toBe(0);
  });
  it('pins and unpins without changing a TELOS star or status', async () => {
    render(<HomePinButton pin={{ kind: 'telos', id: 'goal-1', title: 'Recovery' }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Pin to Today' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Today' }));
    await screen.findByRole('button', { name: 'Unpin from Today' });
    expect(data.preferences.pins).toEqual([{ kind: 'telos', id: 'goal-1', title: 'Recovery' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin from Today' }));
    await waitFor(() => expect(data.preferences.pins).toEqual([]));
    expect(data.fetch.mock.calls.every((call) => call[0] === '/api/home/preferences')).toBe(true);
  });
  it('reports revision conflicts and reloads without claiming a pin was saved', async () => {
    data.conflict = true;
    render(<HomePinButton pin={{ kind: 'session', id: 'session-1', title: 'Recovery' }} />);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Pin to Today' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Today' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed');
    expect(data.preferences.pins).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Unpin from Today' })).toBeNull();
  });
});

describe('daily quote visibility', () => {
  it('saves only the quote setting at its reviewed revision, preserving names and pins', async () => {
    data.preferences.pins = [{ kind: 'session', id: 'one', title: 'Saved' }];
    render(<HomeDisplaySettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Show daily quote on Today' });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(
      JSON.parse(data.fetch.mock.calls.find((call) => call[1]?.method === 'PUT')![1].body),
    ).toEqual({ revision: 0, showDailyQuote: false });
    expect(data.preferences.names.briefing).toBe('Minion');
    expect(data.preferences.pins).toHaveLength(1);
  });
  it('shows saved truth while saving and after failure, and retries only after reviewing current preferences', async () => {
    const original = data.fetch.getMockImplementation()!;
    let resolveSave!: (value: unknown) => void;
    data.fetch.mockImplementation((url: string, options?: RequestInit) =>
      options?.method === 'PUT'
        ? new Promise((resolve) => {
            resolveSave = resolve;
          })
        : original(url, options),
    );
    render(<HomeDisplaySettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Show daily quote on Today' });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    await act(async () => resolveSave({ ok: false, status: 503 }));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t save');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    data.preferences = {
      ...data.preferences,
      revision: 1,
      showDailyQuote: false,
      names: { briefing: 'Remote', terminal: 'Alfred' },
    };
    fireEvent.click(screen.getByRole('button', { name: 'Review current setting' }));
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect(data.fetch.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
    data.fetch.mockImplementation(original);
    fireEvent.click(toggle);
    await waitFor(() => expect(data.preferences.showDailyQuote).toBe(true));
    expect(data.preferences.names.briefing).toBe('Remote');
  });
  it('refreshes a conflict without replaying a stale choice or overwriting another device', async () => {
    render(<HomeDisplaySettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Show daily quote on Today' });
    await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
    data.preferences = {
      ...data.preferences,
      revision: 1,
      names: { briefing: 'Remote', terminal: 'Alfred' },
      pins: [{ kind: 'telos', id: 'other', title: 'Other' }],
    };
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toContain('changed on another device');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(data.preferences.showDailyQuote).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review current setting' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    fireEvent.click(toggle);
    await waitFor(() => expect(data.preferences.showDailyQuote).toBe(false));
    expect(data.preferences.names.briefing).toBe('Remote');
    expect(data.preferences.pins[0].id).toBe('other');
    expect(
      JSON.parse(data.fetch.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![1].body),
    ).toEqual({ revision: 1, showDailyQuote: false });
  });
  it('disables unavailable preferences and allows a load retry', async () => {
    data.fetch.mockResolvedValueOnce({ ok: false });
    render(<HomeDisplaySettings />);
    await screen.findByRole('alert');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each(['false', null, 0])(
    'rejects invalid quote preference responses: %j',
    async (showDailyQuote) => {
      data.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ...data.preferences, showDailyQuote }),
      });
      render(<HomeDisplaySettings />);
      expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load');
      expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    },
  );
});
