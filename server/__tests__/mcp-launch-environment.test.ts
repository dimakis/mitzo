import { expect, it } from 'vitest';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpStdioEnvironment } from '../mcp-launch-environment.js';

it('keeps frozen and absent inherited values through the actual SDK transport', async () => {
  const absent = DEFAULT_INHERITED_ENV_VARS.includes('HOME') ? 'HOME' : 'USERPROFILE';
  const previousPath = process.env.PATH;
  const previousAbsent = process.env[absent];
  let transport: StdioClientTransport | undefined;
  try {
    process.env.PATH = '/snapshot-path';
    delete process.env[absent];
    const env = mcpStdioEnvironment({ MCP_ENV_FIXTURE: 'provided' }, { MCP_ENV_FIXTURE: 'source' });
    process.env.PATH = '/late-path';
    process.env[absent] = '/late-home';
    // A fixed offline child emits one environment notification and exits. It is
    // not a configured server, and performs no network or model calls.
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--max-old-space-size=1024',
        '-e',
        'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture_environment",params:{path:process.env.PATH,hasAbsent:process.argv[1] in process.env,marker:process.env.MCP_ENV_FIXTURE}})+"\\n")',
        absent,
      ],
      env,
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      transport!.onmessage = (message) => {
        if ('method' in message && message.method === 'fixture_environment')
          resolve(message.params as Record<string, unknown>);
      };
      transport!.onerror = reject;
      transport!.onclose = () => reject(Error('Fixture closed before reporting its environment'));
    });
    const [, result] = await Promise.all([transport.start(), received]);
    expect(result).toEqual({ path: '/snapshot-path', hasAbsent: false, marker: 'source' });
  } finally {
    await transport?.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousAbsent === undefined) delete process.env[absent];
    else process.env[absent] = previousAbsent;
  }
});
