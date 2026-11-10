import { geminiThinkingEfforts, geminiTranscriptDefaultEffort } from './gemini-thinking.js';
/** Personal Claude currently has ordinary-chat custody only, not scoped adviser custody. */
export const supportsScopedAdviserProvider = (provider: string) =>
  ['openai', 'openai-codex', 'anthropic-vertex', 'google-vertex'].includes(provider);
export function terminalAdviserCatalog<
  T extends {
    provider: string;
    models: { id: string; reasoningEfforts?: string[]; defaultReasoningEffort?: string }[];
  },
>(accounts: T[]) {
  return accounts
    .filter((account) => supportsScopedAdviserProvider(account.provider))
    .map((account) => ({
      ...account,
      models: account.models.map((model) =>
        account.provider === 'google-vertex'
          ? {
              ...model,
              ...(geminiTranscriptDefaultEffort(model.id)
                ? { defaultReasoningEffort: geminiTranscriptDefaultEffort(model.id) }
                : {}),
              reasoningEfforts: model.reasoningEfforts?.filter((effort) =>
                geminiThinkingEfforts(model.id, true).includes(effort),
              ),
            }
          : model,
      ),
    }));
}
