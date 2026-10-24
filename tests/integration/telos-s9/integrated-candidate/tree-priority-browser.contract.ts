import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('CT13/14 actual App: recursive canonical tree, category pins and provenance survive priority 1–10 writes and reload', async () => {
  const h = await createJoinedOrdinaryApplication();
  const { canonical, page, api, http, front, nativeSessions, chat } = h;
  const insert = canonical.db.prepare(`INSERT INTO items
    (id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,
     categories,context_hints,first_seen,last_seen,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'manual',?,?,?,?,?,?,?)`);
  const add = (id: string, parent: string | null, title: string, categories: string[]) =>
    insert.run(
      id,
      parent,
      title,
      'Retain the original ' + title,
      'Keep canonical provenance',
      JSON.stringify(['Reviewed evidence']),
      5,
      JSON.stringify(categories),
      '{}',
      canonical.stamp,
      canonical.stamp,
      canonical.stamp,
      canonical.stamp,
    );
  add('audio-program', null, 'Audio programme', ['Audio']);
  add('recording-plan', 'studio', 'Recording plan', ['Recording']);
  add('panel-work', 'recording-plan', 'Install acoustic panels', ['Recording']);
  add('code-context', null, 'Repository context review', ['Code']);
  add('legacy-import', null, 'Unclassified retained note', ['Archive']);
  canonical.db
    .prepare('UPDATE items SET parent_id=?,categories=? WHERE id=?')
    .run('audio-program', JSON.stringify(['Recording']), 'studio');
  canonical.db
    .prepare('UPDATE items SET context_hints=? WHERE id=?')
    .run(JSON.stringify({ repos: ['example/acceptance'], paths: ['task.txt'] }), 'code-context');
  canonical.db
    .prepare(
      `INSERT INTO sources
      (id,item_id,type,source_id,url,title,author,timestamp,raw_snippet)
      VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'original-studio-source',
      'studio',
      'manual',
      'synthetic-original-source',
      'https://example.test/acoustic-research',
      'Original acoustic research',
      'Synthetic planner',
      '2026-10-12T09:30:00Z',
      'The original attributed room measurements.',
    );
  const link = canonical.db.prepare(`INSERT INTO links
    (id,item_id,type,url,title,description,created_at) VALUES(?,?,?,?,?,?,?)`);
  link.run(
    'studio-saved-document',
    'studio',
    'artifact',
    canonical.material.url,
    'Reviewed acoustic plan reference',
    'Original immutable material',
    '2026-10-14T11:00:00Z',
  );
  link.run(
    'studio-external-reference',
    'studio',
    'reference',
    'https://example.test/external-notes',
    'External room notes',
    'Separate external reference',
    '2026-10-15T12:00:00Z',
  );
  for (const [itemId, kind] of [
    ['audio-program', 'coordinator'],
    ['studio', 'outcome'],
    ['recording-plan', 'outcome'],
    ['panel-work', 'work_item'],
    ['code-context', 'outcome'],
  ] as const)
    await api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
  const record = async (id = 'studio') =>
    (await (await http('/api/telos/work/items/' + id + '/record')).json()) as {
      priority: number;
      [key: string]: unknown;
    };
  const baselineRecord = await record();
  const sourceRows = canonical.db.prepare('SELECT * FROM sources WHERE item_id=?').all('studio');
  const linkRows = canonical.db.prepare('SELECT * FROM links WHERE item_id=?').all('studio');
  const originalMaterial = canonical.artifacts.read(canonical.material.id, 1);
  const sessionsBefore = chat.eventStore.listSessions().length;
  const snapshots: unknown[] = [];
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  await page.goto(front.origin + '/todos');
  const tree = page.getByRole('region', { name: 'Outcomes tree', exact: true });
  await browserExpect(tree).toBeVisible();
  await tree.getByRole('button', { name: 'All outcomes', exact: true }).click();
  const row = (title: string) =>
    tree.locator('.telos-tree-row').filter({
      has: page.getByRole('button', { name: title, exact: true }),
    });
  await browserExpect(row('Audio programme')).toBeVisible();
  await tree.getByRole('button', { name: 'Expand all', exact: true }).click();
  for (const [title, kind] of [
    ['Audio programme', 'Coordinator'],
    ['Home studio', 'Outcome'],
    ['Recording plan', 'Outcome'],
    ['Install acoustic panels', 'Work item'],
    ['Unclassified retained note', 'Unclassified'],
  ])
    await browserExpect(row(title).locator('.telos-node-copy > .telos-node-meta')).toContainText(
      kind,
    );
  const panelAncestors = await row('Install acoustic panels').evaluate((element) => {
    const titles: string[] = [];
    let node: Element | null = element;
    while (node) {
      if (node.tagName === 'LI') {
        const title = node.querySelector(':scope > .telos-tree-row .telos-node-title');
        if (title?.textContent) titles.push(title.textContent);
      }
      node = node.parentElement;
    }
    return titles;
  });
  expect(panelAncestors).toEqual([
    'Install acoustic panels',
    'Recording plan',
    'Home studio',
    'Audio programme',
  ]);
  await tree.getByRole('button', { name: 'Browse categories', exact: true }).click();
  await tree.getByRole('button', { name: 'Pin Recording', exact: true }).click();
  await tree.getByRole('button', { name: 'Browse categories', exact: true }).click();
  const pins = tree.getByLabel('Pinned categories', { exact: true });
  await pins.getByRole('button', { name: 'Recording', exact: true }).click();
  await browserExpect(row('Install acoustic panels')).toBeVisible();
  await browserExpect(row('Audio programme')).toBeVisible();
  await browserExpect(row('Repository context review')).toHaveCount(0);
  await page.reload();
  await browserExpect(pins.getByRole('button', { name: 'Recording', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await browserExpect(row('Install acoustic panels')).toBeVisible();
  await capture('recursive-recording-tree');
  await row('Install acoustic panels').scrollIntoViewIfNeeded();
  await capture('recursive-panel-work');
  await row('Home studio').getByRole('button', { name: 'Home studio', exact: true }).click();
  await browserExpect(page).toHaveURL(front.origin + '/todos/studio');
  const workspace = page.locator('.telos-item-workspace');
  await browserExpect(
    workspace.getByRole('heading', { name: 'Home studio', exact: true }),
  ).toBeVisible();
  const brief = workspace.getByRole('complementary', { name: 'Original brief' });
  for (const text of [
    'Record music',
    'Make music',
    'Approved plan',
    'Original hint',
    'Original person',
  ]) {
    if (text === 'Original person') await brief.getByText('Context', { exact: true }).click();
    await browserExpect(brief).toContainText(text);
  }
  await browserExpect(brief).toContainText('Synthetic planner');
  await browserExpect(brief).toContainText('Created 2026-10-12T09:30:00Z');
  await browserExpect(brief).toContainText('Added Unknown');
  await browserExpect(brief).toContainText('Updated Unknown');
  await brief
    .getByRole('heading', { name: 'Origin & dates', exact: true })
    .scrollIntoViewIfNeeded();
  await capture('workspace-original-brief');
  await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
  await browserExpect(
    workspace.getByRole('heading', { name: 'Saved document references', exact: true }),
  ).toBeVisible();
  await browserExpect(
    workspace.getByRole('link', { name: /Reviewed acoustic plan reference/ }),
  ).toHaveAttribute('href', /savedArtifact|artifact|path=/);
  await browserExpect(
    workspace.getByRole('region', { name: 'Sources', exact: true }),
  ).toContainText('Original acoustic research');
  await browserExpect(
    workspace.getByRole('link', { name: 'External room notes', exact: true }),
  ).toHaveAttribute('href', 'https://example.test/external-notes');
  await capture('workspace-original-provenance');
  await workspace
    .getByRole('link', { name: 'External room notes', exact: true })
    .scrollIntoViewIfNeeded();
  await capture('workspace-sources-and-external');
  // The same pinned real MGMT CLI used for collection reads now executes only
  // --action priority against this private synthetic DB. This action does not
  // refresh, enrich, publish workload or call an external/provider service.
  const priority = page.getByRole('combobox', { name: 'Priority', exact: true });
  for (let value = 1; value <= 10; value++) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/todos/studio/action'),
      ),
      priority.selectOption(String(value)),
    ]);
    expect(response.request().postDataJSON()).toEqual({ action: 'priority', priority: value });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await browserExpect(priority).toBeEnabled();
    await browserExpect(priority).toHaveValue(String(value));
    expect(canonical.db.prepare('SELECT priority FROM items WHERE id=?').get('studio')).toEqual({
      priority: value,
    });
    const accepted = await record();
    expect(accepted.priority).toBe(value);
    await page.reload();
    await browserExpect(workspace).toBeVisible();
    await browserExpect(priority).toHaveValue(String(value));
    await workspace.getByRole('button', { name: 'Back', exact: true }).click();
    await browserExpect(page).toHaveURL(front.origin + '/todos');
    const badge = row('Home studio').getByLabel(`Priority ${value} out of 10`, { exact: true });
    await browserExpect(badge).toHaveText(`P${value}`);
    await badge.scrollIntoViewIfNeeded();
    await browserExpect(badge).toBeInViewport();
    snapshots.push({
      value,
      canonicalPriority: accepted.priority,
      selector: String(value),
      badge: `P${value}`,
    });
    if (value === 1 || value === 10) await capture('tree-priority-' + value);
    await row('Home studio').getByRole('button', { name: 'Home studio', exact: true }).click();
    await browserExpect(priority).toHaveValue(String(value));
  }
  const beforeInvalid = canonical.db
    .prepare('SELECT priority,updated_at FROM items WHERE id=?')
    .get('studio');
  for (const invalid of [0, 11, 1.5, '3', null]) {
    const response = await page.request.post(front.origin + '/api/todos/studio/action', {
      data: { action: 'priority', priority: invalid },
    });
    expect(response.status()).toBe(400);
    expect(
      canonical.db.prepare('SELECT priority,updated_at FROM items WHERE id=?').get('studio'),
    ).toEqual(beforeInvalid);
  }
  const finalRecord = await record();
  for (const key of [
    'itemId',
    'kind',
    'parentId',
    'summary',
    'intent',
    'rationale',
    'acceptanceCriteria',
    'profile',
    'status',
    'categories',
    'createdAt',
    'contextHints',
    'sources',
    'links',
  ])
    expect(finalRecord[key], key).toEqual(baselineRecord[key]);
  expect(canonical.db.prepare('SELECT * FROM sources WHERE item_id=?').all('studio')).toEqual(
    sourceRows,
  );
  expect(canonical.db.prepare('SELECT * FROM links WHERE item_id=?').all('studio')).toEqual(
    linkRows,
  );
  const material = canonical.artifacts.read(canonical.material.id, 1);
  expect(material.bytes).toEqual(originalMaterial.bytes);
  expect(createHash('sha256').update(material.bytes).digest('hex')).toBe(originalMaterial.sha256);
  expect(nativeSessions).toHaveLength(0);
  expect(chat.eventStore.listSessions()).toHaveLength(sessionsBefore);
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'tree-priority-proof.json'),
      JSON.stringify(
        {
          baselineRecord,
          finalRecord,
          panelAncestors,
          snapshots,
          sourceRows,
          linkRows,
          material: { id: material.id, revision: material.revision, sha256: material.sha256 },
          nativeLaunches: nativeSessions.length,
        },
        null,
        2,
      ),
    );
}, 180_000);
