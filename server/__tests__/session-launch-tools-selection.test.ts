import { expect, it } from 'vitest';
import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { defaultMitzoProfileDefinition } from '@mitzo/protocol';
import { assertSessionLaunchTools } from '../session-launch-tools-selection.js';

const explicit: SymposiumProfileDefinition = {
  ...defaultMitzoProfileDefinition,
  tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
};
it('accepts exposed tools without changing a pinned profile or tool version', () => {
  const before = structuredClone(explicit);
  expect(() => assertSessionLaunchTools(['AgentCommunication'], explicit)).not.toThrow();
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
  (name, profile, reason) => {
    expect(() => assertSessionLaunchTools([name], profile as SymposiumProfileDefinition)).toThrow(
      reason,
    );
  },
);
