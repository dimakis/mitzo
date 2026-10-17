export const STARTUP_PHRASES = [
  'Extorting structural integrity from the primordial goo…',
  'Cajoling the pixels to attention…',
  'Disentangling the quantum spaghetti…',
  'Badgering the dragon into grinding the coffee…',
  'Reconvening the department of nonsense…',
  'Petitioning gravity for a small favour…',
  'Rousing the agent responsible for rousing the agents…',
  'Procrastinating with the tiny goblin in the circuitry…',
  'De-escalating a volcano with a damp tea towel…',
  'Confiscating the sun’s matches…',
  'Interrogating Schrödinger’s cat about its whereabouts…',
  'Distracting the denominator by dividing by zero…',
  'Blackmailing entropy into reassembling the biscuits…',
  'Overshooting infinity by a suspiciously small margin…',
  'Sneaking a remainder into a supposedly perfect division…',
  'Trying to establish which bastard moved the decimal point…',
] as const;
export function chooseStartupPhrase() {
  return STARTUP_PHRASES[Math.floor(Math.random() * STARTUP_PHRASES.length)];
}
