import { expect, it } from 'vitest';
import { agentAdvisorPrompt } from './agent-library';
it('advises exact published pack pins across runtime paths with explicit composed budgets', () => {
  expect(agentAdvisorPrompt).toContain('"version":2,"source":"packs"');
  expect(agentAdvisorPrompt).toContain('local chats, OpenShell and Symposium');
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
  expect(agentAdvisorPrompt).toContain('use published packs for contextRecipe on Symposium seats');
  expect(agentAdvisorPrompt).not.toContain('Version 1 recipes remain local-only');
  expect(agentAdvisorPrompt).not.toContain('leave contextRecipe unset for Symposium seats');
});
