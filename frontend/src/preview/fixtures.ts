import type { FinishedMessage, Session } from '@mitzo/protocol';

const titles = [
  'Improve the workspace UI',
  'Review service permissions',
  'Prepare the weekly briefing',
  'Investigate a reconnect issue on mobile after returning from another app',
  'Plan next release',
  'Review the architecture proposal',
  'Polish the file browser',
  'Follow up on CI failures',
];
export const sessions: Session[] = Array.from({ length: 48 }, (_, i) => ({
  id: `preview-${i + 1}`,
  summary: `${titles[i % titles.length]}${i >= titles.length ? ` · ${Math.floor(i / titles.length) + 1}` : ''}`,
  lastModified: Date.now() - i * 3600000,
  isActive: i < 8,
  totalTokens: 14000 + i * 1700,
  numTurns: 4 + i,
}));
export const messagesFor = (id: string): FinishedMessage[] => [
  {
    messageId: `${id}-user`,
    role: 'user',
    timestamp: Date.now() - 120000,
    blocks: [
      {
        blockId: 'text',
        blockType: 'text',
        content: sessions.find((s) => s.id === id)?.summary ?? 'Start a new conversation',
      },
    ],
  },
  {
    messageId: `${id}-reply`,
    role: 'assistant',
    timestamp: Date.now() - 60000,
    blocks: [
      {
        blockId: 'text',
        blockType: 'text',
        content:
          'This is a preview with sample conversations. It renders the same chat screens as Mitzo.\n\nUse **Chats** to switch conversations on mobile, or the conversation sidebar on desktop. Try a long title, search, or resize the window.',
      },
    ],
  },
];
export const account = {
  id: 'preview',
  label: 'Preview account',
  models: [
    {
      id: 'preview-model',
      label: 'Preview model',
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'low',
    },
  ],
};
export const metadata = {
  accountBinding: { accountId: 'preview', accountLabel: 'Preview account', model: 'preview-model' },
  modelSelection: { model: 'preview-model', reasoningEffort: 'low', models: account.models },
  availableModels: account.models,
  branch: 'session/preview',
  isWorktree: true,
  wtId: 'preview-worktree',
};
