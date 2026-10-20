import { expect, it } from 'vitest';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

it('bundles the public peer message protocol for a browser without private Node persistence', async () => {
  const entry = '\0agent-communication-browser-boundary';
  const protocol = fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url));
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'offline-peer-protocol-entry',
        resolveId: (id) => (id === entry ? entry : null),
        load: (id) =>
          id === entry
            ? `import { AgentMessageSendSchema, agentMessagePrompt } from ${JSON.stringify(protocol)};
           globalThis.peerProtocol = { AgentMessageSendSchema, agentMessagePrompt };`
            : null,
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: { input: entry },
    },
  });
  expect(Array.isArray(result)).toBe(false);
  if (Array.isArray(result) || !('output' in result)) throw Error('Expected one browser bundle');
  const code = result.output
    .filter((part) => part.type === 'chunk')
    .map((part) => part.code)
    .join('\n');
  expect(code).toContain('peerProtocol');
  expect(code).not.toMatch(/node:crypto|__vite-browser-external|agent_communication_messages/);
});
