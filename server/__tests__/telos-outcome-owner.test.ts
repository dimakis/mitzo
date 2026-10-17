import { describe, expect, it, vi } from 'vitest';
import { createCanonicalTelosOutcome } from '../telos-outcome-owner.js';
const input = {
  summary: 'Outcome',
  intent: 'Result',
  rationale: 'Why',
  acceptanceCriteria: ['Evidence'],
  profile: 'manual',
  milestones: ['Slice one'],
  idempotencyKey: 'host-stable-identity',
};
describe('existing canonical Telos creator transport', () => {
  it('preserves recovery and delivery metadata and refuses an incomplete canonical creation receipt', async () => {
    const receipt = {
      ok: true,
      created: false,
      item: { id: 'canonical-item', summary: 'Outcome', children: [{ id: 'slice' }] },
      delivery: { state: 'pending' },
    };
    const execute = vi.fn().mockResolvedValue({ stdout: JSON.stringify(receipt) });
    const options = {
      script: 'configured/todo_api.py',
      exists: () => true,
      timeoutMs: 30000,
      maxBufferBytes: 8388608,
      execute,
    };
    expect(await createCanonicalTelosOutcome(options, input)).toEqual({
      itemId: 'canonical-item',
      receipt,
    });
    execute.mockResolvedValueOnce({
      stdout: JSON.stringify({ ok: true, item: { id: 'canonical-item' } }),
    });
    await expect(createCanonicalTelosOutcome(options, input)).rejects.toThrow();
    execute.mockResolvedValueOnce({
      stdout: JSON.stringify({ ok: false, error: 'profile must be one of: manual, work' }),
    });
    await expect(createCanonicalTelosOutcome(options, input)).rejects.toThrow(
      'profile must be one of: manual, work',
    );
  });

  it('calls the selected Python owner with the original stable creation identity and structured arguments', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        created: true,
        item: { id: 'canonical-item', summary: 'Outcome' },
      }),
    });
    expect(
      await createCanonicalTelosOutcome(
        {
          script: 'configured/todo_api.py',
          exists: () => true,
          execute,
          timeoutMs: 30000,
          maxBufferBytes: 8388608,
        },
        input,
      ),
    ).toEqual({
      itemId: 'canonical-item',
      receipt: { ok: true, created: true, item: { id: 'canonical-item', summary: 'Outcome' } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe('python3');
    expect(execute.mock.calls[0][1].slice(0, 2)).toEqual([
      'configured/todo_api.py',
      '--create-outcome-json',
    ]);
    expect(JSON.parse(execute.mock.calls[0][1][2])).toEqual(input);
    expect(execute.mock.calls[0][2]).toEqual({
      timeout: 30000,
      maxBuffer: 8388608,
      encoding: 'utf8',
    });
  });
  it('refuses missing owners, bad owner replies and invalid proposals without falling back to another store', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ok: false, error: '/private/configuration/path' }),
    });
    const options = {
      script: 'configured/todo_api.py',
      exists: () => true,
      execute,
      timeoutMs: 30000,
      maxBufferBytes: 8388608,
    };
    await expect(
      createCanonicalTelosOutcome({ ...options, exists: () => false }, input),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(createCanonicalTelosOutcome(options, input)).rejects.not.toThrow(/private/);
    execute.mockResolvedValueOnce({ stdout: '{malformed' });
    await expect(createCanonicalTelosOutcome(options, input)).rejects.toThrow();
  });
});
