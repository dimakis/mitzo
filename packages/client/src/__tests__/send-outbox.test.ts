import { describe, it, expect, vi, afterEach } from 'vitest';
import { SendOutbox } from '../send-outbox.js';

const prompt = { type: 'send', sessionId: null, clientMsgId: 'one', prompt: 'hello' };
const ack = (id = 'one') =>
  ({
    ok: true,
    status: 202,
    json: async () => ({ accepted: true, clientMsgId: id, sessionId: 'session' }),
  }) as Response;
afterEach(() => vi.useRealTimers());

describe('send outbox', () => {
  it('discards persisted prompts when authentication identity is lost', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const firstFetch = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    const notify = vi.fn();
    const first = new SendOutbox({ fetch: firstFetch, notify, url: '/send', storage });
    first.start();
    first.enqueue(prompt, 0);

    first.rejectAll('Sign in again');
    const secondFetch = vi.fn();
    const afterLogin = new SendOutbox({ fetch: secondFetch, notify, url: '/send', storage });
    afterLogin.start();
    await Promise.resolve();

    expect(secondFetch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_send_failed', clientMsgId: 'one' }),
    );
  });

  it('surfaces a definitive HTML rejection and lets the next prompt proceed', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => {
          throw new SyntaxError('HTML');
        },
      })
      .mockResolvedValueOnce(ack('two'));
    const notify = vi.fn();
    const outbox = new SendOutbox({ fetch, notify, url: '/send' });
    outbox.enqueue(prompt, 0);
    outbox.enqueue({ ...prompt, clientMsgId: 'two' }, 1);
    outbox.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: '_send_failed',
        clientMsgId: 'one',
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: '_send_accepted',
        clientMsgId: 'two',
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    outbox.stop();
  });

  it.each(['html', 'missing session'])(
    'retains ambiguous %s success for a safe retry',
    async (kind) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 202,
          json: async () => {
            if (kind === 'html') throw new SyntaxError('HTML');
            return { accepted: true, clientMsgId: 'one' };
          },
        })
        .mockResolvedValueOnce(ack());
      const notify = vi.fn();
      const outbox = new SendOutbox({ fetch, notify, url: '/send' });
      outbox.start();
      outbox.enqueue(prompt, 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
      expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: '_send_failed' }));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: '_send_accepted' }));
      outbox.stop();
    },
  );

  it('captures an in-flight acknowledgement while stopped without starting another prompt', async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<Response>((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValue(ack('two'));
    const notify = vi.fn();
    const outbox = new SendOutbox({ fetch, notify, url: '/send' });
    outbox.start();
    outbox.enqueue(prompt, 0);
    outbox.enqueue({ ...prompt, clientMsgId: 'two' }, 0);
    outbox.stop();
    resolve(ack());
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_send_accepted', clientMsgId: 'one' }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    outbox.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(fetch.mock.calls[1][1].body).clientMsgId).toBe('two');
    outbox.stop();
  });

  it.each([429, 500, 503])(
    'retries HTTP %s with the same identity and reports retry status',
    async (status) => {
      vi.useFakeTimers();
      const fetch = vi.fn().mockResolvedValueOnce({ status }).mockResolvedValue(ack());
      const notify = vi.fn();
      const outbox = new SendOutbox({ fetch, notify, url: '/send' });
      outbox.start();
      outbox.enqueue(prompt, 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: '_send_pending', retrying: true, clientMsgId: 'one' }),
      );
      outbox.stop();
    },
  );

  it.each([
    { accepted: 'true', clientMsgId: 'one' },
    { accepted: true, clientMsgId: 'wrong' },
  ])('retains a receipt with invalid identity or acceptance: %j', async (receipt) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ ...receipt, sessionId: 'session' }),
      })
      .mockResolvedValue(ack());
    const outbox = new SendOutbox({ fetch, notify: vi.fn(), url: '/send' });
    outbox.start();
    outbox.enqueue(prompt, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    outbox.stop();
  });

  it('rejects a full queue without discarding an accepted entry', () => {
    let saved = '';
    const outbox = new SendOutbox({
      fetch: vi.fn(),
      notify: vi.fn(),
      url: '/send',
      storage: {
        getItem: () => null,
        setItem: (_, value) => {
          saved = value;
        },
      },
    });
    for (let i = 0; i < 100; i++)
      expect(outbox.enqueue({ ...prompt, clientMsgId: String(i) }, 0)).toBe(true);
    expect(outbox.enqueue({ ...prompt, clientMsgId: 'overflow' }, 0)).toBe(false);
    expect(JSON.parse(saved)).toHaveLength(100);
    expect(JSON.parse(saved)[0].body.clientMsgId).toBe('0');
  });

  it('retries a lost response with the identical command ID without waiting for SSE', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue(ack());
    const notify = vi.fn();
    const outbox = new SendOutbox({ fetch, notify, url: '/send' });
    outbox.start();
    outbox.enqueue(prompt, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: '_send_accepted', clientMsgId: 'one', sessionId: 'session' }),
    );
    outbox.stop();
  });

  it('times out a hung POST and retries automatically', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(ack());
    const outbox = new SendOutbox({ fetch, notify: vi.fn(), url: '/send', timeoutMs: 100 });
    outbox.start();
    outbox.enqueue(prompt, 0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetch).toHaveBeenCalledTimes(2);
    outbox.stop();
  });

  it('also times out a response whose body never arrives', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: () => new Promise(() => {}) })
      .mockResolvedValue(ack());
    const outbox = new SendOutbox({ fetch, notify: vi.fn(), url: '/send', timeoutMs: 100 });
    outbox.start();
    outbox.enqueue(prompt, 0);
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetch).toHaveBeenCalledTimes(2);
    outbox.stop();
  });

  it('binds rapid follow-ups to the first accepted session while keeping new drafts separate', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ack())
      .mockResolvedValueOnce(ack('two'))
      .mockResolvedValueOnce(ack('three'));
    const outbox = new SendOutbox({ fetch, notify: vi.fn(), url: '/send' });
    outbox.enqueue(prompt, 0);
    outbox.enqueue({ ...prompt, clientMsgId: 'two' }, 0);
    outbox.enqueue({ ...prompt, clientMsgId: 'three' }, 1);
    outbox.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(fetch.mock.calls[1][1].body).sessionId).toBe('session');
    expect(JSON.parse(fetch.mock.calls[2][1].body).sessionId).toBeNull();
    outbox.stop();
  });

  it('restores unacknowledged prompts after a reload', async () => {
    vi.useFakeTimers();
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_: string, v: string) => {
        value = v;
      },
    };
    const first = new SendOutbox({ fetch: vi.fn(), notify: vi.fn(), url: '/send', storage });
    first.enqueue(prompt, 0);
    const fetch = vi.fn().mockResolvedValue(ack());
    const second = new SendOutbox({ fetch, notify: vi.fn(), url: '/send', storage });
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(prompt);
    expect(JSON.parse(value!)).toEqual([]);
    second.stop();
  });
});
