import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { telosSourceBrowserData } from '../fixtures/telos-source-data';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { createTelosWorkFixtures } from '../../server/__tests__/fixtures/telos-work-fixtures';
import {
  TelosWorkAdvisorDraftPreviewRequestSchema,
  TelosWorkAdvisorDraftSaveRequestSchema,
} from '../../packages/protocol/src/telos-work-advisor';
import type { TelosWorkView } from '../../packages/protocol/src/telos-work-api';
import { TelosWorkRoleSetupInputSchema } from '../../packages/protocol/src/telos-work-api';

test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-source-navigation.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-role.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
const preparationId = '11111111-1111-4111-8111-111111111111';
const boundId = '22222222-2222-4222-8222-222222222222';
for (const journey of ['lead', 'refine', 'child', 'leaf'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`ordinary ${journey} setup preserves the source and retained chat controls (${theme})`, async ({
      page,
    }, info) => {
      const files = (await compiled).outputFiles;
      const data = await telosSourceBrowserData({
        assistantBoundary: true,
        terminalBookkeeping: true,
      });
      const refining = journey === 'refine' || journey === 'leaf';
      let work: TelosWorkView = {
        ...data.work,
        kind: journey === 'leaf' ? 'work_item' : 'outcome',
      };
      const inventory = localInventoryFixture();
      const actionLabel = journey === 'lead' ? 'Assign lead & open chat' : 'Start chat';
      let savedWork: TelosWorkView | null = null;
      let advisorPreview: { sha256: string; packet: typeof data.source.packet } | undefined;
      const advisorSaves: unknown[] = [];
      const record = {
        ...createTelosWorkFixtures().homeStudio.items[0],
        itemId: 'studio',
        summary: 'Home studio',
        kind: journey === 'leaf' ? 'work_item' : 'outcome',
        intent: 'Record clearly',
      };
      const calls: unknown[] = [],
        unexpected: string[] = [],
        errors: string[] = [];
      const briefText = JSON.stringify({
        summary: 'Home studio',
        intent: 'Record clearly',
        acceptanceCriteria: ['Ready'],
      });
      let selectedContext: Record<string, unknown> | undefined;
      let setupUnavailable = false;
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({
        width: info.project.name.startsWith('mobile') ? 320 : 1280,
        height: 900,
      });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const account = {
        id: 'personal',
        label: 'Personal ChatGPT',
        models: inventory.accounts[0].models,
      };
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.origin !== 'https://mitzo-ui.test') {
          unexpected.push(url.href);
          return route.abort();
        }
        if (path === '/fixture.js' || path === '/fixture.css')
          return route.fulfill({
            contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css',
            body: files.find((f) => f.path.endsWith(path.endsWith('.js') ? '.js' : '.css'))!.text,
          });
        if (path.endsWith('.png') || path.endsWith('.svg'))
          return route.fulfill({
            body: await readFile(resolve('frontend/public', path.slice(1))),
            contentType: path.endsWith('.png') ? 'image/png' : 'image/svg+xml',
          });
        if (path === '/api/telos/work/items/studio/record') return route.fulfill({ json: record });
        if (path === '/api/telos/work/items/advisor-child')
          return route.fulfill({ json: savedWork });
        if (path === '/api/telos/work/items/studio') return route.fulfill({ json: work });
        if (path === '/api/telos/work/roles/context') {
          const request = route.request().postDataJSON();
          selectedContext = {
            version: 1,
            itemId: 'studio',
            role: request.role,
            ...(request.advisorPurpose ? { advisorPurpose: request.advisorPurpose } : {}),
            brief: {
              revision: work.revision,
              sha256: createHash('sha256').update(briefText).digest('hex'),
              text: briefText,
            },
            parentCriteria: [],
            overallGoal: { itemId: 'studio', revision: work.revision, text: 'Record clearly' },
            sources: work.sources.filter((s) => request.sourceSnapshotIds.includes(s.snapshotId)),
            artifacts: request.artifactRefs,
          };
          return route.fulfill({ json: selectedContext });
        }
        if (path === '/api/telos/work/roles/setup') {
          const input = TelosWorkRoleSetupInputSchema.parse(route.request().postDataJSON());
          calls.push(input);
          if (setupUnavailable)
            return route.fulfill({ status: 503, json: { error: 'Offline interrupted response' } });
          const role = input.role,
            conversation = { namespace: 'mitzo' as const, conversationId: boundId };
          work = {
            ...work,
            revision: 'f'.repeat(64),
            links: [
              ...work.links,
              {
                version: 1,
                linkId: 'bound-role',
                itemId: 'studio',
                role,
                conversation,
                linkedAt: '2026-10-17T10:00:00Z',
                linkedBy: 'offline-operator',
                availability: 'available',
                attemptId: null,
              },
            ],
            assignments:
              role === 'lead' && input.expectedAssignmentRevision !== null
                ? [
                    {
                      itemId: 'studio',
                      role: 'lead',
                      conversation,
                      revision: input.expectedAssignmentRevision + 1,
                      assignedAt: '2026-10-17T10:00:00Z',
                      assignedBy: 'offline-operator',
                    },
                  ]
                : work.assignments,
          };
          return route.fulfill({
            json: { actorId: 'operator:offline', commandId: 'role-setup', work },
          });
        }
        if (path === '/api/telos/work/advisor/preview') {
          const input = TelosWorkAdvisorDraftPreviewRequestSchema.parse(
            route.request().postDataJSON(),
          );
          const packet = {
            ...data.source.packet,
            itemId: journey === 'child' ? 'advisor-child' : 'studio',
            workRevision: input.expectedRevision,
            selection: input.selection,
            brief: {
              text: JSON.stringify(input.proposed),
              sha256: createHash('sha256').update(JSON.stringify(input.proposed)).digest('hex'),
            },
            context: {
              ...data.source.packet.context,
              sourceConversationId: boundId,
              boundary: input.selection.boundary,
            },
          };
          advisorPreview = {
            packet,
            sha256: createHash('sha256').update(JSON.stringify(packet)).digest('hex'),
          };
          return route.fulfill({ json: advisorPreview });
        }
        if (path === '/api/telos/work/advisor/save') {
          const input = TelosWorkAdvisorDraftSaveRequestSchema.parse(
            route.request().postDataJSON(),
          );
          advisorSaves.push(input);
          expect(input.previewSha256).toBe(advisorPreview!.sha256);
          if (journey === 'leaf') {
            expect(input.operation).toBe('refine');
            expect(input.proposed.type).toBe('work_item');
          }
          const itemId = journey === 'child' ? 'advisor-child' : 'studio';
          const snapshot = {
            ...data.work.sources[0],
            itemId,
            snapshotId: 'advisor-source',
            source: { namespace: 'mitzo' as const, conversationId: boundId },
            selection: {
              kind: 'selected' as const,
              messageIds: input.selection.messageIds.length
                ? input.selection.messageIds
                : ['approved'],
              blockIds: [],
              throughSequence: input.selection.boundary.sequence,
            },
          };
          savedWork = {
            ...work,
            itemId,
            kind: journey === 'child' ? 'work_item' : 'outcome',
            parentId: journey === 'child' ? 'studio' : null,
            revision: 'd'.repeat(64),
            links:
              journey === 'child'
                ? [
                    {
                      version: 1,
                      linkId: 'advisor-origin',
                      itemId,
                      role: 'origin' as const,
                      conversation: { namespace: 'mitzo' as const, conversationId: boundId },
                      linkedAt: '2026-10-17T10:00:00Z',
                      linkedBy: 'offline',
                      availability: 'available' as const,
                      attemptId: null,
                    },
                  ]
                : work.links,
            assignments: [],
            sources: journey === 'child' ? [snapshot] : [...work.sources, snapshot],
            attempts: [],
          };
          return route.fulfill({
            json: { actorId: 'operator:offline', commandId: 'saved-draft', work: savedWork },
          });
        }
        if (path === '/api/telos/work/links') return route.fulfill({ json: [] });
        if (path.startsWith('/api/telos/work/items/studio/sources/'))
          return route.fulfill({ json: data.source });
        if (path === '/api/telos/items/advisor-child/artifacts')
          return route.fulfill({ json: { artifacts: [], limit: 100 } });
        if (path === '/api/telos/items/studio/artifacts')
          return route.fulfill({ json: { artifacts: [], limit: 100 } });
        if (path === '/api/todos')
          return route.fulfill({
            json: {
              items: [
                ...(savedWork && journey === 'child'
                  ? [
                      {
                        id: 'advisor-child',
                        summary: 'Reviewed studio slice',
                        profile: 'personal',
                        status: 'active',
                        starred: false,
                        urgency: 0,
                        ageDays: 0,
                        parentId: 'studio',
                        children: [],
                        childCount: 0,
                        completedChildCount: 0,
                        sources: [],
                        goalId: null,
                        intent: 'Record the reviewed first session',
                        rationale: '',
                        acceptanceCriteria: [],
                        contextHints: {
                          repos: [],
                          paths: [],
                          issues: [],
                          docIds: [],
                          people: [],
                          jiraKeys: [],
                          keywords: [],
                          taskHint: '',
                        },
                      },
                    ]
                  : []),
                {
                  id: 'studio',
                  summary: 'Home studio',
                  profile: 'personal',
                  status: 'active',
                  starred: false,
                  urgency: 0,
                  ageDays: 0,
                  parentId: null,
                  children: [],
                  childCount: 0,
                  completedChildCount: 0,
                  sources: [],
                  goalId: null,
                  intent: 'Record clearly',
                  rationale: 'Make music',
                  acceptanceCriteria: ['Ready'],
                  contextHints: {
                    repos: [],
                    paths: [],
                    issues: [],
                    docIds: [],
                    people: [],
                    jiraKeys: [],
                    keywords: [],
                    taskHint: '',
                  },
                },
              ],
              profiles: ['personal'],
            },
          });
        if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
        if (path === '/api/repository-workspaces/catalog')
          return route.fulfill({
            json: {
              available: true,
              repositories: [
                {
                  connectionId: 'github',
                  repository: 'owner/repository',
                  label: 'Offline repository',
                },
              ],
            },
          });
        if (path === `/api/repository-workspaces/${preparationId}`)
          return route.fulfill({
            json: {
              id: preparationId,
              repository: 'owner/repository',
              baseBranch: 'main',
              baseOid: 'a'.repeat(40),
              featureBranch: 'task-fixture',
              state: 'ready',
            },
          });
        if (path === '/api/accounts') return route.fulfill({ json: [account] });
        if (path === '/api/sessions')
          return route.fulfill({
            json: {
              sessions: [
                {
                  id: 'planning',
                  summary: 'Studio planning',
                  lastModified: 1792144800000,
                  isActive: false,
                },
              ],
              hasMore: false,
            },
          });
        if (path.endsWith('/messages'))
          return route.fulfill({
            json: {
              messages: path.includes('/planning/') || journey !== 'lead' ? data.messages : [],
              current: null,
              currents: [],
              cursor: path.includes('/planning/') || journey !== 'lead' ? data.cursor : 0,
            },
          });
        if (path.endsWith('/meta'))
          return route.fulfill({
            json: {
              sessionId: path.split('/')[3],
              sessionType: 'chat',
              mode: 'agent',
              numTurns: 0,
              ...(path.includes(boundId)
                ? {
                    telosWorkRoleContext: selectedContext,
                    runtimeBinding: {
                      version: 2,
                      account: inventory.accounts[0].account,
                      harness: { implementation: 'codex' },
                      execution: {
                        location: 'local',
                        targetId: 'mac',
                        targetRevision: 'target-r1',
                      },
                    },
                    runtimeCommandScope: 'conversation',
                    repositoryWorkspaceId: preparationId,
                    agentProfile: inventory.agentProfiles[0],
                  }
                : {}),
              accountBinding: {
                ...inventory.accounts[0].account,
                accountLabel: 'Personal ChatGPT',
                model: 'luna-fixture',
              },
              modelSelection: {
                model: 'luna-fixture',
                reasoningEffort: 'low',
                models: account.models,
              },
            },
          });
        if (path.endsWith('/symposium/status'))
          return route.fulfill({
            json: { sessionId: path.split('/')[3], config: null, seats: [], deliveries: [] },
          });
        if (path.endsWith('/compactions'))
          return route.fulfill({ json: { records: [], truncated: false } });
        if (path.startsWith('/api/chat/web-search-consent/'))
          return route.fulfill({
            json: { ok: true, grant: 'denied', revision: 1, updatedAt: 1792144800000 },
          });
        if (
          ['/api/home/briefing-chats', '/api/skills', '/api/symposium/profile-proposals'].includes(
            path,
          )
        )
          return route.fulfill({ json: [] });
        if (path === '/api/home/preferences')
          return route.fulfill({
            json: { revision: 0, names: { briefing: 'Briefing', terminal: 'Terminal' }, pins: [] },
          });
        if (path === '/api/agent-library')
          return route.fulfill({ json: { drafts: [], versions: inventory.agentProfiles } });
        if (path === '/api/service-health')
          return route.fulfill({ json: { services: [], checkedAt: 1792144800000 } });
        if (['/api/config', '/api/version'].includes(path)) return route.fulfill({ json: {} });
        if (path.startsWith('/api/')) {
          unexpected.push(`${route.request().method()} ${path}`);
          return route.fulfill({ status: 404, json: { error: 'Unavailable offline' } });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html{font-size:${theme === 'light' ? '125%' : '100%'}}html,body,#root{height:100%;margin:0}.chat-page{min-height:0}.workspace-work{padding:var(--page-gutter)}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.goto('/todos/studio');
      await expect(page.getByRole('button', { name: 'Open original chat' })).toBeVisible();
      if (journey === 'leaf') {
        await expect(page.getByRole('button', { name: 'Choose worker' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Refine item' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Add child with advisor' })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`leaf-item-${theme}.png`) });
      }
      await page
        .getByRole('button', {
          name:
            journey === 'lead'
              ? 'Choose lead collaborator'
              : refining
                ? 'Refine item'
                : 'Add child with advisor',
        })
        .click();
      await expect(page.getByRole('button', { name: actionLabel })).toBeDisabled();
      expect(calls).toHaveLength(0);
      await page.addInitScript(
        ({ inventory, preparationId }) => {
          const id = new URL(location.href).searchParams.get('draft');
          if (!id) return;
          const key = `mitzo-chat-draft:${id}`;
          const draft = JSON.parse(localStorage.getItem(key)!);
          draft.settings.selection = {
            accountId: 'personal',
            model: 'luna-fixture',
            reasoningEffort: 'low',
          };
          draft.settings.runtimeSelection = {
            version: 1,
            account: draft.settings.selection,
            accountReference: inventory.accounts[0].account,
            agentProfile: { profileId: 'agent', revision: 1 },
            execution: { location: 'local', targetId: 'mac' },
            capabilityRevision: inventory.capabilityRevision,
          };
          draft.settings.repositoryWorkspaceId = preparationId;
          localStorage.setItem(key, JSON.stringify(draft));
        },
        { inventory, preparationId },
      );
      await page.waitForLoadState('networkidle');
      await page.reload();
      const assign = page.getByRole('button', { name: actionLabel });
      await expect(assign).toBeEnabled();
      await page
        .getByRole('button', { name: /Settings/ })
        .first()
        .click();
      await expect(page.getByText('Run on', { exact: true })).toBeVisible();
      await expect(page.getByText('Runs with Codex', { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`role-settings-${theme}.png`) });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      setupUnavailable = true;
      await assign.focus();
      await expect(assign).toBeFocused();
      await assign.press('Enter');
      await expect(
        page.getByText('Setup could not be confirmed. Retry to recover the same request.'),
      ).toBeVisible();
      setupUnavailable = false;
      await page.waitForLoadState('networkidle');
      await page.reload();
      await page.getByRole('button', { name: actionLabel }).click();
      await expect(page).toHaveURL(new RegExp(`/chat/${boundId}$`));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(work.sources).toEqual(data.work.sources);
      expect(work.attempts).toEqual([]);
      await expect(page.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open session tray' })).toBeAttached();
      await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toBeVisible();
      await page.getByText('Linked brief · goal & parent context', { exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Message Mitzo' })
        .fill('Unsent follow-up retained in this ordinary chat.');
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      await page.screenshot({ path: info.outputPath(`role-bound-chat-${theme}.png`) });
      if (journey !== 'lead') {
        await page
          .getByRole('button', {
            name: refining ? 'Propose refinement' : 'Suggest a draft',
          })
          .click();
        await page
          .getByLabel('Name', { exact: true })
          .fill(journey === 'child' ? 'Reviewed studio slice' : 'Home studio');
        await page
          .getByLabel('Desired outcome', { exact: true })
          .fill('Record the reviewed first session');
        await page.getByLabel('Category', { exact: true }).fill('Personal projects');
        const proposal = page.getByRole('region', { name: 'Advisor proposal' });
        await expect
          .poll(() => proposal.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeLessThanOrEqual(1);
        await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
        await expect(page.getByLabel('Name', { exact: true })).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`advisor-${journey}-${theme}.png`) });
        const save = page.getByRole('button', {
          name: refining ? 'Save refinement' : 'Save child draft',
        });
        await save.scrollIntoViewIfNeeded();
        await expect(save).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`advisor-save-${journey}-${theme}.png`) });
        await save.click();
        await expect(page).toHaveURL(
          new RegExp('/todos/' + (journey === 'child' ? 'advisor-child' : 'studio') + '$'),
        );
        expect(advisorSaves).toHaveLength(1);
        expect(savedWork!.attempts).toEqual([]);
        expect(savedWork!.assignments).toEqual([]);
      }
      expect(await page.evaluate(() => window.fixtureSends)).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    });
