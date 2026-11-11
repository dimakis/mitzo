import { expect, it } from 'vitest';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { defaultMitzoProfileDefinition } from '@mitzo/protocol';
import { assertSessionLaunchTools } from '../session-launch-tools-selection.js';

const explicit: SymposiumProfileDefinition = {
  ...defaultMitzoProfileDefinition,
  tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
};
it.each([
  'TelosStartSlice',
  'TelosWorkControl',
  'TelosGetItem',
  'TelosUpdateItem',
  'RequestGithubMainPublication',
])(
  'refuses role-dependent %s for a fresh ordinary chat even when explicitly selected',
  async (name) => {
    for (const profile of [
      defaultMitzoProfileDefinition,
      {
        ...defaultMitzoProfileDefinition,
        tools: [{ id: `mitzo:${name}`, version: 1 }],
      },
    ]) {
      await expect(assertSessionLaunchTools([name], profile)).rejects.toThrow(
        /retained Telos role/,
      );
    }
  },
);
it('accepts exposed tools without changing a pinned profile or tool version', async () => {
  const before = structuredClone(explicit);
  await expect(assertSessionLaunchTools(['AgentCommunication'], explicit)).resolves.toBeUndefined();
  expect(explicit).toEqual(before);
});
it.each([
  ['TaskExecution', explicit, /not selected/],
  ['AgentCommunication', { ...explicit, tools: [] }, /not selected/],
  [
    'AgentCommunication',
    { ...explicit, tools: [{ id: 'mitzo:AgentCommunication', version: 2 }] },
    /not selected/,
  ],
  ['ImaginaryTool', defaultMitzoProfileDefinition, /unavailable/],
  ['PrepareRepositoryChat', defaultMitzoProfileDefinition, /unavailable/],
] as const)(
  'refuses incompatible tool %s without widening the profile',
  async (name, profile, reason) => {
    await expect(
      assertSessionLaunchTools([name], profile as SymposiumProfileDefinition),
    ).rejects.toThrow(reason);
  },
);
