import { expect, it } from 'vitest';
import { agentAdvisorPrompt } from './agent-library';
it('advises exact published pack pins on supported routes with explicit composed budgets', () => {
  expect(agentAdvisorPrompt).toContain('"version":2,"source":"packs"');
  expect(agentAdvisorPrompt).toContain(
    'Keep profiles and pack definitions independent of account, model and runtime',
  );
  expect(agentAdvisorPrompt).toContain(
    'Ordinary Claude SDK, OpenAI Responses and Gemini/Vertex chats support published packs',
  );
  expect(agentAdvisorPrompt).toContain('Native Codex routes do not support packs');
  expect(agentAdvisorPrompt).toContain(
    'including local and OpenShell chats, native Symposium API/subscription seats and approved native search threads',
  );
  expect(agentAdvisorPrompt).toContain(
    'Native pack delivery requires a reviewed native build and enrollment with a trusted source-authority barrier before every provider continuation',
  );
  expect(agentAdvisorPrompt).toContain(
    'settings or application tool callbacks alone cannot enable it',
  );
  expect(agentAdvisorPrompt).toContain('Profiles and packs can still be curated and published');
  expect(agentAdvisorPrompt).not.toContain('Published pack recipes support local chats, OpenShell');
  expect(agentAdvisorPrompt).toContain('final composed token budget');
  expect(agentAdvisorPrompt).toContain('exact published id, revision and hash');
  expect(agentAdvisorPrompt).toContain(
    'Version 1 workspace and ContexGin recipes remain compatible with local chats',
  );
  expect(agentAdvisorPrompt).not.toContain('leave contextRecipe unset for those uses');
  expect(agentAdvisorPrompt).toContain('explicit save and publication');
});
it('keeps legacy OpenShell workspace and preset support distinct from pack support', () => {
  expect(agentAdvisorPrompt).toContain(
    'Version 1 workspace and ContexGin recipes remain compatible with local chats and supported OpenShell sandboxes',
  );
  expect(agentAdvisorPrompt).toContain(
    'For version 1 recipes, OpenShell compiles selected workspace documents inside the owning sandbox through a reviewed runtime',
  );
  expect(agentAdvisorPrompt).toContain('Named presets also need a host-configured sandbox recipe');
  expect(agentAdvisorPrompt).toContain('Shared knowledge still refreshes separately between turns');
  expect(agentAdvisorPrompt).toContain(
    'Native Codex and Claude Symposium seats require a profile without a context recipe',
  );
  expect(agentAdvisorPrompt).toContain('Native Gemini Symposium dispatch is unsupported');
  expect(agentAdvisorPrompt).toContain(
    'Version 1 recipes are unsupported on native Symposium seats',
  );
  expect(agentAdvisorPrompt).not.toContain(
    'use published packs for contextRecipe on Symposium seats',
  );
  expect(agentAdvisorPrompt).not.toContain('Version 1 recipes remain local-only');
  expect(agentAdvisorPrompt).not.toContain('leave contextRecipe unset for Symposium seats');
});
