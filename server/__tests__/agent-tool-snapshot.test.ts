import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeResponsesStore } from '../native-responses-store.js';
const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai' as const,
  model: 'luna-fixture',
  profileRevision: 'v1',
};
it('pins the admitted catalog across cold resume and rejects changed definitions, selection or account without replacing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-snapshot-'));
  let store = new NativeResponsesStore(join(root, 'native.db'));
  const snapshot = {
    profileHash: 'a'.repeat(64),
    tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object' } }],
  };
  try {
    store.bindAgentTools('chat', binding, snapshot, false);
    store.close();
    store = new NativeResponsesStore(join(root, 'native.db'));
    expect(() => store.bindAgentTools('chat', binding, snapshot, true)).not.toThrow();
    for (const changed of [
      { ...snapshot, tools: [] },
      { ...snapshot, profileHash: 'b'.repeat(64) },
      {
        ...snapshot,
        tools: [{ ...snapshot.tools[0], description: 'Replacement executor contract' }],
      },
    ])
      expect(() => store.bindAgentTools('chat', binding, changed, true)).toThrow(
        /catalog changed/i,
      );
    expect(() =>
      store.bindAgentTools('chat', { ...binding, accountId: 'other' }, snapshot, true),
    ).toThrow(/binding changed/i);
    expect(() => store.bindAgentTools('missing', binding, snapshot, true)).toThrow(
      /snapshot unavailable/i,
    );
    expect(() => store.bindAgentTools('chat', binding, snapshot, true)).not.toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
