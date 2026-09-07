import { expect, it, vi } from 'vitest';
import { NativeCommandRegistry } from '../native-commands.js';
import { AccountProfiles } from '../account-profiles.js';
import type { SkillRegistry } from '../skills.js';
it('refreshes the account catalogs on command and reports discovery failure', async () => {
  const refresh = vi.spyOn(AccountProfiles.prototype, 'refresh').mockResolvedValue(undefined);
  const catalog = vi.spyOn(AccountProfiles.prototype, 'catalog').mockReturnValue([
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      billing: 'chatgpt-subscription',
      models: [{ id: 'gpt', label: 'GPT' }],
      modelDiscovery: { stale: true, updatedAt: undefined },
      capabilities: { streaming: true, tools: true, images: true },
    },
  ]);
  try {
    const result = await new NativeCommandRegistry().execute(
      'models',
      'refresh',
      {} as SkillRegistry,
    );
    expect(refresh).toHaveBeenCalledWith(true);
    expect(result?.content).toContain('GPT');
    expect(result?.content).toContain('refresh failed');
  } finally {
    refresh.mockRestore();
    catalog.mockRestore();
  }
});
