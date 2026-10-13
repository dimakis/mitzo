import { expect, it } from 'vitest';
import { agentAdvisorPrompt, agentAdvisorHref } from './agent-library';
import { profileBuilderDefinition } from '@mitzo/protocol';
it('launches a pinned builder profile and keeps system guidance out of the user message', () => {
  const url = new URL(agentAdvisorHref, 'https://mitzo.example');
  expect(url.searchParams.get('agentProfile')).toBe('mitzo-profile-builder');
  expect(url.searchParams.get('profileRevision')).toBe('1');
  expect(url.searchParams.get('agentProfileKind')).toBe('builtin');
  expect(url.searchParams.get('prompt')).toBe('Help me create an agent.');
  expect(agentAdvisorPrompt.length).toBeLessThan(100);
  expect(profileBuilderDefinition.instructions).toContain('SymposiumProposeProfile');
  expect(profileBuilderDefinition.instructions).toContain('SymposiumReadProfiles');
  expect(profileBuilderDefinition.instructions).toContain('not just descriptions or JSON in chat');
});
it('keeps profile and context compatibility guidance in the builder profile', () => {
  const guidance = profileBuilderDefinition.instructions;
  expect(guidance).toContain('independent of accounts, models and runtime grants');
  expect(guidance).toContain('must be exact, never invented');
  expect(guidance).toContain('Claude SDK, OpenAI Responses and Gemini/Vertex chats support packs');
  expect(guidance).toContain(
    'native Codex routes and native Symposium seats require profiles without pack recipes',
  );
  expect(guidance).toContain('Native Claude Symposium seats require no context recipe');
  expect(guidance).toContain('Native Gemini Symposium dispatch is unsupported');
});
