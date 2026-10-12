import { z } from 'zod';
import { apiFetch } from './api-fetch';
import { deleteChatDraft, getChatDraft, type ChatDraft } from './chat-drafts';

const preparationSchema = z.object({
  id: z.uuid(),
  state: z.enum(['preview', 'ready', 'failed', 'discarded']),
});

function assertUnchanged(snapshot: ChatDraft): void {
  if (JSON.stringify(getChatDraft(snapshot.id)) !== JSON.stringify(snapshot))
    throw new Error('This draft changed. Your edits were kept. Review it before discarding again.');
}

/** Release only a verified unused preparation; never erase a newer draft revision. */
export async function discardChatDraft(snapshot: ChatDraft): Promise<void> {
  assertUnchanged(snapshot);
  const id = snapshot.settings.repositoryWorkspaceId;
  if (id) {
    const binding = snapshot.settings.selection;
    if (!binding?.accountId || !binding.model)
      throw new Error(
        'The repository account is unavailable. The draft and preparation were kept.',
      );
    const query = new URLSearchParams({ accountId: binding.accountId, model: binding.model });
    const url = `/api/repository-workspaces/${encodeURIComponent(id)}?${query}`;
    let response: Response;
    let preparation: z.infer<typeof preparationSchema>;
    try {
      response = await apiFetch(url);
      if (!response.ok) throw new Error('Preparation unavailable');
      preparation = preparationSchema.parse(await response.json());
      if (preparation.id !== id) throw new Error('Preparation identity changed');
    } catch {
      throw new Error(
        'Couldn’t verify an unused repository preparation. The draft and preparation were kept. Open the draft to check its status.',
      );
    }
    assertUnchanged(snapshot);
    try {
      response = await apiFetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok || (await response.json()).discarded !== true)
        throw new Error('Discard was not confirmed');
    } catch {
      throw new Error(
        'Couldn’t release the repository preparation. The draft and preparation were kept. Try again.',
      );
    }
    assertUnchanged(snapshot);
  }
  if (!deleteChatDraft(snapshot.id)) throw new Error('Couldn’t discard this draft. Try again.');
}
