import { geminiThinkingEfforts } from './gemini-thinking.js';
export function terminalAdviserCatalog<
  T extends {
    provider: string;
    models: { id: string; reasoningEfforts?: string[] }[];
  },
>(accounts: T[]) {
  return accounts
    .filter((account) => account.provider !== 'openai-codex')
    .map((account) => ({
      ...account,
      models: account.models.map((model) =>
        account.provider === 'google-vertex'
          ? {
              ...model,
              reasoningEfforts: model.reasoningEfforts?.filter((effort) =>
                geminiThinkingEfforts(model.id, true).includes(effort),
              ),
            }
          : model,
      ),
    }));
}
