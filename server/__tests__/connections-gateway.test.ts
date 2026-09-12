import { describe, expect, it, vi } from 'vitest';
import { OpenShellConnectionGateway } from '../connections-gateway.js';
const signal = new AbortController().signal;
describe('OpenShellConnectionGateway', () => {
  it('uses a key-only credential and never exposes a token in argv or parsed DTOs', async () => {
    const secret = 'SENTINEL_DO_NOT_LEAK';
    const runner = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: 'p1', name: 'mitzo-conn-12345678', workspace: 'default', type: 'jira-readonly' },
        ]),
      );
    const gateway = new OpenShellConnectionGateway(runner, { workspace: 'default' });
    await gateway.provision({ name: 'mitzo-conn-12345678', token: secret }, signal);
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain(secret);
    expect(runner.mock.calls[0][1].env).toEqual({ JIRA_API_TOKEN: secret });
  });
  it('paginates strict JSON provider metadata', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      name: `mitzo-conn-${String(i).padStart(8, '0')}`,
      workspace: 'default',
      type: 'jira-readonly',
    }));
    const runner = vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce('[]');
    await expect(new OpenShellConnectionGateway(runner).list(signal)).resolves.toHaveLength(100);
    expect(runner.mock.calls[1][0]).toContain('100');
  });
});
