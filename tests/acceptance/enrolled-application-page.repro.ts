import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { expect as uiExpect } from '@playwright/test';
import { ConnectionRegistry } from '@mitzo/harness';
import { CollaborationApplicationReviewResultSchema } from '@mitzo/protocol';
import { assertPlaywrightHost } from '../support/playwright-host';
import { createApplicationBrowserTransport } from './application-browser-transport';

// External tool configuration only; every application/auth/account/profile/source
// owner and API is original. In particular there is NO repository importer mock.
vi.mock('../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
}));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function exactBrowserBundle(directory: string) {
  const entry = 'tests/acceptance/symposium-page-entry.tsx';
  const defines = { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' };
  if (process.env.CI === 'true') {
    await mkdir(directory, { recursive: true });
    const bundled = await build({
      entryPoints: [resolve(entry)],
      bundle: true,
      write: false,
      metafile: true,
      outfile: resolve(directory, 'actual-chat.js'),
      external: ['/*.png', '/*.svg'],
      jsx: 'automatic',
      minify: true,
      define: defines,
      alias: {
        '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
        '@mitzo/client': resolve('packages/client/src/index.ts'),
        '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
      },
    });
    const inputs: Record<string, string> = {};
    const virtualInputs: Record<string, string> = {};
    const dependencies = await realpath(resolve('node_modules'));
    for (const input of Object.keys(bundled.metafile!.inputs)) {
      if (input === '<define:import.meta.env>') {
        virtualInputs[input] = sha(defines['import.meta.env']);
        continue;
      }
      const absolute = await realpath(resolve(input));
      const logical = absolute.startsWith(dependencies + '/')
        ? 'node_modules/' + relative(dependencies, absolute)
        : relative(process.cwd(), absolute);
      if (logical.startsWith('../'))
        throw Error('Unexpected browser input outside source/dependencies');
      inputs[logical] = sha(await readFile(absolute));
    }
    const files: Record<string, string> = {};
    for (const output of bundled.outputFiles!) {
      const name = relative(directory, output.path);
      files[name] = sha(output.contents);
      await writeFile(join(directory, name), output.contents);
    }
    await writeFile(
      join(directory, 'source-manifest.json'),
      JSON.stringify(
        {
          entry,
          inputs,
          virtualInputs,
          defines,
          files,
          scope: 'Actual UI bundle only; no approved reference render.',
        },
        null,
        2,
      ),
    );
  } else if (!process.env.SYMPOSIUM_PAGE_BUNDLE_DIR) {
    throw Error(
      'BLOCKED: build this exact page bundle in CI; local browser execution requires its retained bundle directory',
    );
  }
  const manifest = JSON.parse(await readFile(join(directory, 'source-manifest.json'), 'utf8')) as {
    entry: string;
    inputs: Record<string, string>;
    virtualInputs: Record<string, string>;
    defines: Record<string, string>;
    files: Record<string, string>;
  };
  expect(manifest.entry).toBe(entry);
  expect(manifest.defines).toEqual(defines);
  expect(manifest.virtualInputs).toEqual({
    '<define:import.meta.env>': sha(defines['import.meta.env']),
  });
  for (const [input, expected] of Object.entries(manifest.inputs))
    expect(sha(await readFile(resolve(input))), input).toBe(expected);
  const assets = new Map<string, { contentType: string; bytes: Uint8Array | string }>();
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!['actual-chat.js', 'actual-chat.css'].includes(file))
      throw Error('Unexpected CI bundle file');
    const bytes = await readFile(join(directory, file));
    expect(sha(bytes)).toBe(expected);
    assets.set('/c-acceptance/' + file, {
      contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
      bytes,
    });
  }
  return { assets, manifest };
}

it('uses a genuine enrolled ordinary SOURCE and actual page Add Review edit refreeze without joining or further inference', async () => {
  assertPlaywrightHost();
  const engine = process.env.SYMPOSIUM_PAGE_BROWSER ?? 'chromium';
  if (!['chromium', 'webkit'].includes(engine)) throw Error('Select one browser explicitly');
  const evidence = resolve(
    process.env.SYMPOSIUM_PAGE_EVIDENCE_DIR ??
      '../implementation-evidence/page-g2-b498-candidate/' + engine,
  );
  await mkdir(evidence, { recursive: true });
  const bundle = await exactBrowserBundle(
    resolve(process.env.SYMPOSIUM_PAGE_BUNDLE_DIR ?? join(evidence, 'bundle')),
  );
  const cleanup: Array<() => void | Promise<void>> = [];
  const bootstrap = await mkdtemp(join(tmpdir(), 'symposium-page-bootstrap-'));
  cleanup.push(() => rm(bootstrap, { recursive: true, force: true }));
  for (const key of Object.keys(process.env))
    if (
      /^(MITZO_|TELOS_DB_PATH$|OPENAI_|ANTHROPIC_|GOOGLE_|VERTEX_|CLOUD_ML_|NTFY_|PUSHOVER_|APNS_|CONTEXT|CONTEXGIN|LOKI_|OTEL_|MCP_|GH_TOKEN$|GITHUB_TOKEN$)/.test(
        key,
      )
    )
      vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({
    REPO_PATH: bootstrap,
    MITZO_CODEX_PRIVATE_DIR: join(bootstrap, 'private'),
    MITZO_INTERNAL_TOKEN_PATH: join(bootstrap, 'internal-token'),
    MITZO_MODEL_LIMITS_CATALOG_FILE: join(bootstrap, 'model-limits.json'),
    AUTH_PASSPHRASE: 'offline-symposium-page-passphrase',
    AUTH_SECRET: 'offline-symposium-page-secret-at-least-32-bytes',
    COOKIE_MAX_AGE_HOURS: '1',
    MITZO_OPENSHELL_ENABLED: '0',
    MITZO_OPENSHELL_SANDBOX_NAME: '',
    WORKTREE_ENABLED: 'false',
    CLAUDE_CODE_USE_VERTEX: '0',
  }))
    vi.stubEnv(key, value);
  await writeFile(join(bootstrap, 'model-limits.json'), '{}');
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let succeeded = false;
  const providerRequests: unknown[] = [];
  const browserErrors: string[] = [];
  const outsideRequests: string[] = [];
  const responses: Array<{ method: string; path: string; status: number; body?: unknown }> = [];
  const responseReads: Promise<void>[] = [];
  try {
    const { enrolledResponsesOwnerFixture } =
      await import('../../server/__tests__/fixtures/enrolled-responses-owner');
    const { enrolledRepositorySourceFixture } =
      await import('../../server/__tests__/fixtures/enrolled-repository-source');
    const f = await enrolledResponsesOwnerFixture(cleanup);
    const { ordinaryLocalResponsesContractRevision } =
      await import('../../server/ordinary-local-responses-capabilities');
    const targetPath = join(f.root, 'responses-target.json');
    await writeFile(
      targetPath,
      JSON.stringify({
        version: 1,
        targetId: 'offline-local',
        label: 'Offline local',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalResponsesContractRevision(),
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE', targetPath);
    const source = await enrolledRepositorySourceFixture(f, cleanup);
    await mkdir(join(f.root, '.claude', 'repository-tasks'), { recursive: true, mode: 0o700 });
    const application = await import('../../server/app');
    const chat = await import('../../server/chat');
    const nativeHistory = await import('../../server/responses-chat-session');
    const auth = await import('../../server/auth');
    const { NativeCommandRegistry } = await import('../../server/native-commands');
    const { mountApplicationChatTransport } = await import('../../server/chat-rest-handler');
    const { nativeStartupSessionId } = await import('../../server/ordinary-repository-startup');
    const { getAgentLibrary } = await import('../../server/agent-library-runtime');
    const sessionId = nativeStartupSessionId(`repository:${source.workspace.id}`);
    const connections = new ConnectionRegistry();
    chat.setConnectionRegistry(connections);
    application.setConnectionsRuntime(f.runtime);
    auth.setAuthRevocationStore(chat.eventStore);
    mountApplicationChatTransport(application.app, application.chatSseRegistry, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      nativeCommands: new NativeCommandRegistry(),
    });
    cleanup.push(async () => {
      const live = chat.registry.findBySessionId(sessionId);
      if (live) {
        if (!live.session.ordinaryRuntimeOwner?.closeIdle)
          throw Error('Original idle release unavailable');
        await live.session.ordinaryRuntimeOwner.closeIdle();
      }
      connections.dispose();
      chat.setConnectionRegistry(null);
      application.setConnectionsRuntime(null);
      nativeHistory.getNativeResponsesStore().close();
      await application.closeIdleApplicationResources();
    });
    const library = getAgentLibrary();
    library.saveDraft('user', {
      profileId: 'source-agent',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'draft',
      definition: {
        name: 'Source agent',
        descriptor: 'Offline assistant',
        role: 'agent',
        instructions: 'Read the repository.',
        expectedOutput: 'Answer',
        acceptanceCriteria: ['Use source'],
        modelPolicyRole: 'agent',
        tools: [],
      },
    });
    library.publish('user', {
      profileId: 'source-agent',
      expectedVersion: 1,
      idempotencyKey: 'publish',
    });
    // One strict external provider completion establishes the ordinary source.
    // Enrollment's separate validation requests use the original injected HTTP port.
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST')
        throw Error('Unexpected external source fetch');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('gpt-6-luna');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer SYNTHETIC_OFFLINE_ENROLLMENT_KEY',
      );
      expect(chat.eventStore.getLatestOrdinaryCommandAdmission(sessionId)?.state).toBe('consumed');
      providerRequests.push(body);
      if (providerRequests.length !== 1)
        throw Error('Add/Review/refreeze must not start inference');
      const events = [
        {
          type: 'response.created',
          response: { id: 'offline-source-response', model: body.model },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text' },
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Offline source answer',
        },
        { type: 'response.content_part.done', output_index: 0, content_index: 0 },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Offline source answer' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    bundle.assets.set(`/chat/${sessionId}`, {
      contentType: 'text/html',
      bytes:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/c-acceptance/actual-chat.css"></head><body><div id="root"></div><script src="/c-acceptance/actual-chat.js"></script></body></html>',
    });
    for (const file of await readdir(resolve('frontend/public')))
      if (/\.(svg|png)$/.test(file))
        bundle.assets.set('/' + file, {
          contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          bytes: await readFile(resolve('frontend/public', file)),
        });
    let cookie = '';
    const http = await createApplicationBrowserTransport(
      application.app,
      () => cookie,
      bundle.assets,
    );
    cleanup.push(() => http.close());
    const login = await http.request('POST', '/api/auth/login', {
      body: { passphrase: process.env.AUTH_PASSPHRASE },
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers['set-cookie'];
    cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    expect(cookie).toMatch(/^cc_auth=.+/);
    const actor = (await auth.authenticateToken(cookie.slice('cc_auth='.length)))!;
    const stream = new http.EventSource('/api/chat/events');
    cleanup.push(async () => {
      stream.close();
      await vi.waitFor(() => expect(application.chatSseRegistry.size).toBe(0));
    });
    const welcome = await new Promise<{ connectionId: string }>((resolveWelcome, reject) => {
      const timer = setTimeout(() => reject(Error('Source stream welcome unavailable')), 5000);
      stream.addEventListener(
        'welcome',
        (event) => {
          clearTimeout(timer);
          resolveWelcome(JSON.parse((event as MessageEvent).data));
        },
        { once: true },
      );
      stream.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(Error('Source stream failed'));
        },
        { once: true },
      );
    });
    const caps = await http.request('GET', '/api/chat/runtime/capabilities', {
      headers: { cookie },
    });
    expect(caps.status).toBe(200);
    const route = caps.body.routes.find(
      (entry: { harness: string; account: { accountId: string } }) =>
        entry.harness === 'responses' && entry.account.accountId === f.binding.accountId,
    );
    expect(route).toBeDefined();
    const sent = await http.request('POST', '/api/chat/runtime/send', {
      headers: { cookie, 'X-Connection-ID': welcome.connectionId, Origin: http.baseUrl },
      body: {
        runOn: 'local',
        repositoryWorkspaceId: source.workspace.id,
        clientMsgId: randomUUID(),
        capabilityRevision: route.capabilityRevision,
        runtime: {
          account: route.account,
          harness: 'responses',
          targetId: 'offline-local',
          mode: 'agent',
        },
        selection: {
          version: 1,
          agent: { profileId: 'source-agent', revision: 1 },
          context: { source: 'none', revision: null },
          permission: { mode: 'agent', revision: 0 },
          model: 'gpt-6-luna',
          thinking: 'low',
        },
        payload: { text: 'Read the repository source.' },
      },
    });
    expect(sent).toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
    await vi.waitFor(
      () => expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('TERMINAL'),
      { timeout: 10000 },
    );
    expect(providerRequests).toHaveLength(1);
    const enrollmentValidationPosts = f.calls.requests.filter((request) =>
      request.startsWith('POST '),
    ).length;
    expect(enrollmentValidationPosts).toBe(1);
    const { ordinaryCodexContinuationStatus } =
      await import('../../server/ordinary-codex-continuation-status');
    expect(ordinaryCodexContinuationStatus(sessionId, actor.id)).toEqual({ available: true });
    expect(
      nativeHistory.getNativeResponsesStore().load(sessionId, f.binding)?.history.length,
    ).toBeGreaterThan(0);
    const beforeSessions = chat.eventStore
      .listSessions()
      .map((s) => s.sessionId)
      .sort();
    stream.close();
    await vi.waitFor(() => expect(application.chatSseRegistry.size).toBe(0));
    // Browser execution has no request fulfillment/intercepted API responses.
    browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: engine === 'webkit' ? 390 : 1280, height: 844 },
      isMobile: engine === 'webkit',
      hasTouch: engine === 'webkit',
      colorScheme: 'dark',
    });
    await context.addCookies([
      {
        name: 'cc_auth',
        value: cookie.slice('cc_auth='.length),
        url: http.baseUrl,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await context.route('**/*', (request) => {
      if (new URL(request.request().url()).origin === http.baseUrl) return request.continue();
      outsideRequests.push(request.request().url());
      return request.abort();
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    page = await context.newPage();
    page.on('pageerror', (error) => browserErrors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/')) return;
      responseReads.push(
        (async () => {
          const record = {
            method: response.request().method(),
            path: url.pathname + url.search,
            status: response.status(),
            body: undefined as unknown,
          };
          if ((response.headers()['content-type'] ?? '').includes('application/json'))
            record.body = await response.json();
          responses.push(record);
        })().catch((error) => {
          browserErrors.push(`Response capture: ${String(error)}`);
        }),
      );
    });
    await page.goto(`${http.baseUrl}/chat/${sessionId}`);
    const agents = page.getByRole('button', { name: /^Agents/ }).first();
    await uiExpect(agents).toBeVisible({ timeout: 10000 });
    await agents.click();
    await page.getByRole('button', { name: 'Add agent', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add agent', exact: true });
    await uiExpect(add).toBeVisible();
    const agentValue = await add
      .getByLabel('Agent', { exact: true })
      .getByRole('option', { name: /Source agent/ })
      .getAttribute('value');
    expect(agentValue).toBeTruthy();
    await add.getByLabel('Agent', { exact: true }).selectOption(agentValue!);
    await add.getByLabel('Account', { exact: true }).selectOption(f.binding.accountId);
    await add.getByLabel('Model', { exact: true }).selectOption('gpt-6-luna');
    const thinking = add.getByLabel('Thinking level', { exact: true });
    if (await thinking.count()) await thinking.selectOption('low');
    await add
      .getByLabel('Purpose', { exact: true })
      .fill('Independently review the selected source.');
    await add.getByLabel('Name in this chat', { exact: true }).fill('Reviewer');
    await add.getByLabel('Context', { exact: true }).selectOption('selected');
    const sourceMessage = add.getByRole('checkbox', { name: /Read the repository source\./ });
    await sourceMessage.check();
    const reviewButton = add.getByRole('button', { name: 'Review joining brief', exact: true });
    await uiExpect(reviewButton).toBeEnabled();
    const captures: Array<{
      platform: string;
      width: number;
      height: number;
      theme: string;
      state: string;
      file: string;
      sha256: string;
    }> = [];
    const captureState = async (
      state: string,
      dialog: import('@playwright/test').Locator,
      footerButton: import('@playwright/test').Locator,
    ) => {
      for (const width of engine === 'webkit' ? [390, 320] : [1280])
        for (const theme of ['dark', 'light'] as const) {
          await page!.setViewportSize({ width, height: 844 });
          await page!.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          await uiExpect(page!.locator('html')).toHaveAttribute('data-theme', theme);
          const body = dialog.locator('.conversation-agents-body');
          await body.hover();
          await page!.mouse.wheel(0, -5000);
          const upperFile = `${engine}-${width}-${theme}-${state}-upper.png`;
          const upper = await page!.screenshot({ path: join(evidence, upperFile), fullPage: true });
          captures.push({
            platform: engine,
            width,
            height: 844,
            theme,
            state: state + ': upper content',
            file: upperFile,
            sha256: sha(upper),
          });
          await footerButton.scrollIntoViewIfNeeded();
          await uiExpect(footerButton).toBeInViewport();
          if (engine === 'webkit') {
            const bounds = await footerButton.boundingBox();
            expect(bounds?.height).toBeGreaterThanOrEqual(44);
          }
          const file = `${engine}-${width}-${theme}-${state}-footer.png`;
          const bytes = await page!.screenshot({ path: join(evidence, file), fullPage: true });
          captures.push({
            platform: engine,
            width,
            height: 844,
            theme,
            state: state + ': reachable footer',
            file,
            sha256: sha(bytes),
          });
        }
    };
    await captureState('add-agent', add, reviewButton);
    await reviewButton.click();
    const review = page.getByRole('dialog', { name: 'Before joining', exact: true });
    await uiExpect(review).toBeVisible();
    await review.getByText('Review included context', { exact: false }).click();
    const brief = review.getByRole('textbox', { name: /Joining brief/ });
    await uiExpect(brief).toBeEditable();
    await brief.fill(
      'Independently review the exact selected source. Keep its identity and quoted bytes.',
    );
    const joinButton = review.getByRole('button', { name: 'Join conversation', exact: true });
    await uiExpect(joinButton).toBeDisabled();
    await uiExpect
      .poll(() => responses.filter((r) => r.method === 'POST' && /\/reviews$/.test(r.path)).length)
      .toBeGreaterThanOrEqual(2);
    await uiExpect(review.getByText('Read the repository source.', { exact: true })).toBeVisible();
    await captureState('before-joining-refrozen', review, joinButton);
    expect(providerRequests).toHaveLength(1);
    expect(f.calls.requests.filter((request) => request.startsWith('POST '))).toHaveLength(
      enrollmentValidationPosts,
    );
    expect(
      chat.eventStore
        .listSessions()
        .map((s) => s.sessionId)
        .sort(),
    ).toEqual(beforeSessions);
    expect(outsideRequests).toEqual([]);
    expect(browserErrors).toEqual([]);
    await page.keyboard.press('Escape');
    await uiExpect(review).toBeHidden();
    await uiExpect(agents).toBeFocused();
    await Promise.all(responseReads);
    const reviews = responses.filter((r) => r.method === 'POST' && /\/reviews$/.test(r.path));
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    await Promise.all(responseReads);
    expect(browserErrors).toEqual([]);
    const initialReview = CollaborationApplicationReviewResultSchema.parse(reviews[0].body);
    const refrozen = CollaborationApplicationReviewResultSchema.parse(reviews.at(-1)!.body);
    expect(refrozen.snapshot.sourceConversationId).toBe(sessionId);
    expect(refrozen.snapshot.mode).toBe('selected');
    expect(refrozen.snapshot.messages).toHaveLength(1);
    expect(refrozen.snapshot.messages).toEqual(initialReview.snapshot.messages);
    expect(refrozen.snapshot.messages[0].blocks.map((b) => b.content).join('')).toBe(
      'Read the repository source.',
    );
    expect(refrozen.snapshot.joiningBrief).toBe(
      'Independently review the exact selected source. Keep its identity and quoted bytes.',
    );
    expect(refrozen.snapshot.capacity.status).toBe('unverified');
    expect(refrozen.snapshot.snapshotId).not.toBe(initialReview.snapshot.snapshotId);
    expect(refrozen.settings.repositoryWorkspaceId).not.toBe(source.workspace.id);
    expect(source.owner.get(refrozen.settings.repositoryWorkspaceId)).toBeDefined();
    await writeFile(
      join(evidence, 'observed.json'),
      JSON.stringify(
        {
          sessionId,
          sourceWorkspaceId: source.workspace.id,
          sourceBaseOid: source.baseOid,
          sourceActorId: actor.id,
          routeCapabilityRevision: route.capabilityRevision,
          initialSimulatedSourceGenerationRequests: providerRequests.length,
          initialSimulatedEnrollmentValidationPosts: enrollmentValidationPosts,
          furtherModelRequests: 0,
          captures,
          responses,
          browserErrors,
          outsideRequests,
          bundleManifest: bundle.manifest,
          qualification:
            'Candidate actual page only; no fresh join/native count/Ready/finalized participant reply or accepted-main/live qualification.',
        },
        null,
        2,
      ),
    );
    succeeded = true;
  } finally {
    if (page && !succeeded) {
      await page
        .screenshot({ path: join(evidence, 'failure.png'), fullPage: true })
        .catch(() => {});
      await writeFile(
        join(evidence, 'failure.html'),
        await page.content().catch(() => 'Page unavailable'),
      );
    }
    await Promise.all(responseReads);
    await writeFile(
      join(evidence, 'network.json'),
      JSON.stringify(
        {
          responses,
          browserErrors,
          outsideRequests,
          providerRequestCount: providerRequests.length,
        },
        null,
        2,
      ),
    );
    await context?.tracing.stop({ path: join(evidence, 'trace.zip') });
    await context?.close();
    await browser?.close();
    for (const close of cleanup.reverse()) await close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}, 60000);
