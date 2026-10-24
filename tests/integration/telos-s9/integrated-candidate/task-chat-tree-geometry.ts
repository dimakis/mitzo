import { expect } from 'vitest';
import { expect as browserExpect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';

/** Read actual DOM geometry only. No style, content, callback or data override. */
export async function inspectTaskReadability(
  page: Page,
  input: {
    taskId: string;
    title: string;
    summary: string;
    evidenceValue: string;
    workerId: string;
    legacySessionId: string | null;
    stage: string;
    width: number;
  },
) {
  const root = page.locator('#task-' + input.taskId);
  await root.scrollIntoViewIfNeeded();
  const value = root.locator(':scope > .task-node-artifacts .task-node-artifact-value');
  await browserExpect(root.locator(':scope > .task-node-row .task-node-title')).toHaveText(
    input.title,
  );
  await browserExpect(root.locator(':scope > .task-node-row .task-node-summary')).toHaveText(
    input.summary,
  );
  expect(await value.textContent()).toBe(input.evidenceValue);
  const text = (await value.textContent())!;
  const link = root.locator(':scope > .task-node-row .task-node-session-link');
  const sessionLinks = await link.evaluateAll((nodes) =>
    nodes.map((node) => ({ href: node.getAttribute('href'), text: node.textContent })),
  );
  if (sessionLinks.length) {
    await browserExpect(link).toHaveAttribute('href', '/chat/' + input.legacySessionId);
    await browserExpect(link).toHaveText(input.legacySessionId!.slice(0, 6));
  }
  const geometry = await root.evaluate((node) => {
    const box = (r: DOMRect) => ({
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    });
    const row = node.querySelector(':scope > .task-node-row')!;
    const texts = Array.from(
      node.querySelectorAll(
        ':scope > .task-node-row .task-node-title,:scope > .task-node-row .task-node-summary,:scope > .task-node-artifacts .task-node-artifact-value',
      ),
    ).map((element) => {
      const column = element.closest('.task-node-artifact') ?? element;
      const bounds = column.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const ranges = Array.from(range.getClientRects()).map(box);
      return {
        className: element.className,
        text: element.textContent,
        bounds: box(bounds),
        ranges,
        outside: ranges.filter((r) => r.left < bounds.left - 1 || r.right > bounds.right + 1),
        overflowX: getComputedStyle(element).overflowX,
        whiteSpace: getComputedStyle(element).whiteSpace,
      };
    });
    const widths = [
      node,
      row,
      ...node.querySelectorAll(
        ':scope > .task-node-artifacts,:scope > .task-node-artifacts .task-node-artifact',
      ),
    ].map((element) => ({
      className: element.className,
      client: element.clientWidth,
      scroll: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    const controls = Array.from(row.querySelectorAll('button,a.task-node-session-link')).map(
      (control) => {
        const bounds = control.getBoundingClientRect(),
          rowBounds = row.getBoundingClientRect(),
          actions = control.closest('.task-node-actions');
        return {
          name:
            control.getAttribute('aria-label') ||
            control.getAttribute('title') ||
            control.textContent,
          tag: control.tagName,
          href: control.getAttribute('href'),
          bounds: box(bounds),
          inRow: bounds.left >= rowBounds.left - 1 && bounds.right <= rowBounds.right + 1,
          opacity: actions
            ? Number(getComputedStyle(actions).opacity)
            : Number(getComputedStyle(control).opacity),
        };
      },
    );
    const scroller = node.closest('.task-board-scroll')!;
    return {
      texts,
      widths,
      controls,
      node: box(node.getBoundingClientRect()),
      row: box(row.getBoundingClientRect()),
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      scroller: { client: scroller.clientWidth, scroll: scroller.scrollWidth },
    };
  });
  return {
    ...input,
    sessionLinks,
    exactRawText: text,
    utf8Bytes: Buffer.byteLength(text),
    rawTextSha256: createHash('sha256').update(text).digest('hex'),
    geometry,
  };
}

/** Soft visual assertions allow the SAME baseline case to finish task approval. */
export function assertTaskReadability(result: Awaited<ReturnType<typeof inspectTaskReadability>>) {
  const { geometry: g, stage, width } = result;
  expect
    .soft(
      result.sessionLinks,
      `${stage}/${width}: actual TaskBoard retains its optional exact legacy session link`,
    )
    .toEqual(
      result.legacySessionId
        ? [{ href: '/chat/' + result.legacySessionId, text: result.legacySessionId.slice(0, 6) }]
        : [],
    );
  expect
    .soft(
      g.texts.filter((t) => t.outside.length || ['hidden', 'clip'].includes(t.overflowX)),
      `${stage}/${width}: full title/summary/raw-artifact text inside reading column`,
    )
    .toEqual([]);
  expect
    .soft(
      g.widths.filter((w) => w.scroll > w.client + 1 || ['hidden', 'clip'].includes(w.overflowX)),
      `${stage}/${width}: wrap raw evidence without clipping`,
    )
    .toEqual([]);
  expect
    .soft(
      g.controls.filter(
        (c) => !c.inRow || c.bounds.width < 44 || c.bounds.height < 44 || c.opacity < 0.99,
      ),
      `${stage}/${width}: visible in-row 44px task controls/session link`,
    )
    .toEqual([]);
  expect
    .soft(g.node.width, `${stage}/${width}: actual available TaskNode width`)
    .toBeLessThanOrEqual(width);
  expect
    .soft(g.pageWidth, `${stage}/${width}: page horizontal bounds`)
    .toBeLessThanOrEqual(g.viewport + 1);
  expect
    .soft(g.scroller.scroll, `${stage}/${width}: task scroller horizontal bounds`)
    .toBeLessThanOrEqual(g.scroller.client + 1);
}

/** Exercise natural browser Tab order; never programmatically focus a target. */
export async function tabToTaskControl(page: Page, target: Locator) {
  const trace = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    trace.push(
      await page.evaluate(() => {
        const e = document.activeElement;
        return {
          tag: e?.tagName,
          name:
            e?.getAttribute('aria-label') ||
            e?.getAttribute('title') ||
            e?.textContent?.slice(0, 120),
          href: e?.getAttribute('href'),
          taskId: e?.closest('.task-node')?.id,
        };
      }),
    );
    if (await target.evaluate((element) => element === element.ownerDocument.activeElement))
      return trace;
  }
  await browserExpect(target, JSON.stringify(trace)).toBeFocused();
  return trace;
}
