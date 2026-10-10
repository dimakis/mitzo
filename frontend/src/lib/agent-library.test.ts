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
