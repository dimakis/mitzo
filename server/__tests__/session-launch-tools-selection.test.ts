import { expect, it } from 'vitest';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { defaultMitzoProfileDefinition } from '@mitzo/protocol';
import { assertSessionLaunchTools } from '../session-launch-tools-selection.js';

const explicit: SymposiumProfileDefinition = {
  ...defaultMitzoProfileDefinition,
  tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
};
it('rejects the repository-chat tool on the owned native route even when explicitly selected', async () => {
  await expect(
    assertSessionLaunchTools(['PrepareRepositoryChat'], {
      ...defaultMitzoProfileDefinition,
      tools: [{ id: 'mitzo:PrepareRepositoryChat', version: 1 }],
    }),
  ).rejects.toThrow(/unavailable/);
});
it.each(['PrepareLocalRepository', 'DiscoverLocalRepository', 'InspectLocalRepository'])(
  'qualifies native registration prerequisites for %s without widening a profile',
  async (name) => {
    const primitives = ['Bash', 'Read', 'Write', 'Edit'];
    for (const missing of [null, ...primitives]) {
      const selected = {
        ...defaultMitzoProfileDefinition,
        tools: [name, ...primitives.filter((primitive) => primitive !== missing)].map((tool) => ({
          id: `mitzo:${tool}`,
          version: 1,
        })),
      };
      const before = structuredClone(selected);
      const result = assertSessionLaunchTools([name], selected);
      if (missing) await expect(result).rejects.toThrow(/Bash.*Read.*Write.*Edit/);
      else await expect(result).resolves.toBeUndefined();
      expect(selected).toEqual(before);
    }
    await expect(
      assertSessionLaunchTools([name], {
        ...defaultMitzoProfileDefinition,
        tools: [{ id: `mitzo:${name}`, version: 1 }],
      }),
    ).rejects.toThrow(/Bash.*Read.*Write.*Edit/);
  },
);
it.each(['TelosSaveArtifact', 'TelosReadArtifact'])(
  'requires an explicitly selected profile to expose %s in the resulting ordinary chat',
  async (name) => {
    await expect(assertSessionLaunchTools([name], defaultMitzoProfileDefinition)).rejects.toThrow(
      /explicit.*select/i,
    );
    const selected = {
      ...defaultMitzoProfileDefinition,
      tools: [{ id: `mitzo:${name}`, version: 1 }],
    };
    const before = structuredClone(selected);
    await expect(assertSessionLaunchTools([name], selected)).resolves.toBeUndefined();
    expect(selected).toEqual(before);
    await expect(assertSessionLaunchTools([name], { ...selected, tools: [] })).rejects.toThrow(
      /not selected/,
    );
  },
);
it.each([
  'TelosStartSlice',
  'TelosCreateSession',
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
