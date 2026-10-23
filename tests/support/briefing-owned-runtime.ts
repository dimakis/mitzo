import { expect, type Page } from '@playwright/test';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
} from '../../packages/protocol/src/index';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import type { ExplicitLocalInventory } from '../../frontend/src/lib/explicit-local-chat';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { openChatSetting } from './chat-settings';

/** Explicit synthetic enrollment only for selected briefing journeys. */
export function briefingRuntimeInventory() {
  const inventory: ExplicitLocalInventory = {
    ...localInventoryFixture(),
    defaultLocalRepository: true,
  };
  inventory.agentProfiles = [
    {
      kind: 'builtin',
      profileId: DEFAULT_MITZO_PROFILE_ID,
      revision: DEFAULT_MITZO_PROFILE_REVISION,
      definition: defaultMitzoProfileDefinition,
      contentHash: sha256Hex(JSON.stringify(defaultMitzoProfileDefinition)),
    },
  ];
  inventory.accounts[0].account = {
    accountId: 'work-account',
    provider: 'openai-codex',
    profileRevision: 'briefing-routing-r1',
  };
  inventory.accounts[0].label = 'Work OpenAI';
  inventory.accounts[0].models = ['luna-fixture', 'luna-other-fixture', 'luna-alternate'].map(
    (id) => ({ id, label: id, reasoningEfforts: ['low', 'medium', 'high'] }),
  );
  inventory.routes[0].account = inventory.accounts[0].account;
  inventory.routes[0].capabilityRevision = 'briefing-selected-route-r1';
  return inventory;
}
export async function enableBriefingRuntime(page: Page) {
  const inventory = briefingRuntimeInventory();
  await page.route('**/api/chat/**/capabilities*', (route) => route.fulfill({ json: inventory }));
  return inventory;
}
export async function reviewBriefingRuntime(page: Page) {
  await openChatSetting(page, 'account');
  await page.getByRole('button', { name: 'Work OpenAI', exact: true }).click();
  await openChatSetting(page, 'execution');
  await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
  await openChatSetting(page, 'thinking');
  await page.getByRole('button', { name: 'low', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send launch prompt', exact: true })).toBeEnabled();
}

/** Stable offline SSE receiver; no backend or provider connection is opened. */
export async function installBriefingSse(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem('mitzo:transport');
    class FixtureEventSource extends EventTarget {
      readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) {
        super();
        if (url.includes('/api/chat/events')) {
          (window as unknown as { briefingFixtureSse: FixtureEventSource }).briefingFixtureSse =
            this;
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent('welcome', {
                  data: JSON.stringify({ connectionId: 'offline-briefing-owner' }),
                }),
              ),
            0,
          );
        }
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = FixtureEventSource as unknown as typeof EventSource;
  });
}
