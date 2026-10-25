import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';
import { createFakeVoiceEffects } from './joined-fake-voice-effects';

type MediaObservation = {
  captures: number;
  trackStops: number;
  decoded: number;
  playbackStarts: number;
  unlockStarts: number;
  playbackStops: number;
};
declare global {
  interface Window {
    __s9Media: MediaObservation;
  }
}
type Row = {
  label: string;
  sessionId: string;
  text: string;
  reply: string;
  draft: string;
  command: unknown;
  editedSha256: string;
  originalSha256: string;
  media: MediaObservation;
  access: unknown;
};

it('uses healthy real service/proxy paths for synthetic voice and delivers saved image markup through guarded ordinary and Telos native turns', async () => {
  const external = await createFakeVoiceEffects();
  const nodeFetch = globalThis.fetch;
  vi.stubEnv('YAPPER_PROXY_TARGET', external.origin);
  vi.stubEnv('CONTEXGIN_URL', external.origin);
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 390, height: 900 } });
  h.cleanup.push(() => external.close());
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== external.origin + '/health')
      throw Error('External fetch forbidden: ' + input);
    return nodeFetch(input, init);
  });
  const { HealthMonitor } = await import('../../../../server/health-monitor.js');
  const monitor = new HealthMonitor(h.application.sseRegistry);
  h.application.setHealthMonitor(monitor);
  h.cleanup.push(() => {
    monitor.destroy();
    h.application.yapperWsProxy.close();
  });
  // The exact production index.ts upgrade branch, on the already-owned private
  // app listener. No new app runtime, alternate owned API or route fulfilment.
  h.front.server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url!, h.front.origin).pathname.startsWith('/api/yapper-ws'))
      h.application.yapperWsProxy.upgrade(req, socket as Socket, head);
    else socket.destroy();
  });
  monitor.start();
  await vi.waitFor(() =>
    expect(monitor.getSnapshot().services).toContainEqual({
      name: 'yapper',
      ok: true,
      detail: { stt: true, tts: true },
    }),
  );
  const { api, f, prepared, page, front, nativeSessions, chat } = h;
  await page.addInitScript(() => {
    const observed = {
      captures: 0,
      trackStops: 0,
      decoded: 0,
      playbackStarts: 0,
      unlockStarts: 0,
      playbackStops: 0,
    };
    Object.assign(window, { __s9Media: observed });
    const Audio = window.AudioContext;
    const decode = Audio.prototype.decodeAudioData;
    Audio.prototype.decodeAudioData = function (...args: Parameters<typeof decode>) {
      observed.decoded++;
      return decode.apply(this, args);
    };
    const create = Audio.prototype.createBufferSource;
    Audio.prototype.createBufferSource = function () {
      const source = create.call(this),
        start = source.start.bind(source),
        stop = source.stop.bind(source);
      source.start = (...args: Parameters<typeof source.start>) => {
        if (source.buffer?.length === 1) observed.unlockStarts++;
        else observed.playbackStarts++;
        start(...args);
      };
      source.stop = (...args: Parameters<typeof source.stop>) => {
        observed.playbackStops++;
        stop(...args);
      };
      return source;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        observed.captures++;
        const context = new Audio(),
          destination = context.createMediaStreamDestination(),
          silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(destination);
        silence.start();
        await context.resume();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            observed.trackStops++;
            stop();
            silence.stop();
            void context.close();
          };
        }
        return destination.stream;
      },
    });
  });
  const ordinaryId = f.first.receipt.sessionId;
  expect(await api.links({ namespace: 'mitzo', conversationId: ordinaryId })).toEqual([]);
  await api.execute({
    operation: 'classify',
    itemId: 'studio',
    kind: 'outcome',
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
  });
  const review = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const setup = await api.setupReviewedOrdinaryRole({
    version: 2,
    presentationRef: review.presentationRef,
    input: {
      version: 2,
      itemId: 'studio',
      requestId: randomUUID(),
      role: 'lead',
      expectedRevision: review.selection.brief.revision,
      expectedAssignmentRevision: 0,
      contextSelection: review.selection,
      settings: {
        version: 2,
        binding: prepared.runtimeBinding,
        selection: f.first.request.selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
    },
  });
  const ids = [ordinaryId, setup.work.assignments[0].conversation.conversationId];
  const meta = await Promise.all(
    ids.map(async (id) => (await h.http('/api/sessions/' + id + '/meta')).json()),
  );
  for (const field of ['runtimeBinding', 'accountBinding', 'agentProfile'])
    expect(meta[1][field]).toEqual(meta[0][field]);
  const rows: Row[] = [];
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  const hash = (data: string) =>
    createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  for (const [index, id] of ids.entries()) {
    const label = index ? 'telos' : 'ordinary',
      transcript = 'Synthetic ' + label + ' voice transcript.';
    external.setTranscript(transcript);
    await page.goto(front.origin + '/chat/' + id);
    await composer.fill('Independent ' + label + ' prefix.');
    await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
    await vi.waitFor(() => expect(external.recordings[index]?.bytes).toBeGreaterThan(0));
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await browserExpect(composer).toHaveValue('Independent ' + label + ' prefix. ' + transcript);
    expect(external.recordings[index]).toMatchObject({
      ended: true,
      transcript,
      format: { format: 'webm/opus' },
    });
    expect(nativeSessions).toHaveLength(index);
    const original = await page.evaluate((which: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = which ? '#ffee88' : '#88eeff';
      context.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/png').split(',')[1];
    }, index);
    await page.locator('input[type=file]').setInputFiles({
      name: label + '-synthetic.png',
      mimeType: 'image/png',
      buffer: Buffer.from(original, 'base64'),
    });
    await page.getByRole('button', { name: 'Preview attachment 1', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Image preview', exact: true });
    await browserExpect(
      editor.getByRole('button', { name: 'Save image', exact: true }),
    ).toBeEnabled();
    await editor.getByRole('button', { name: 'Draw', exact: true }).click();
    const box = await editor.locator('[aria-label="Image drawing surface"]').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.8, { steps: 8 });
    await page.mouse.up();
    await browserExpect(editor.locator('[data-markup-stroke]')).toHaveCount(1);
    await capture(label + '-markup-before-save');
    await editor.getByRole('button', { name: 'Save image', exact: true }).click();
    await browserExpect(editor).toBeHidden();
    await page.getByRole('button', { name: 'Preview attachment 1', exact: true }).click();
    const edited = await editor
      .getByRole('img', { name: 'Attached image', exact: true })
      .getAttribute('src');
    expect(edited).toMatch(/^data:image\/png;base64,/);
    const editedData = edited!.split(',')[1];
    expect(hash(editedData)).not.toBe(hash(original));
    await browserExpect(
      editor.getByRole('button', { name: 'Save image', exact: true }),
    ).toBeEnabled();
    expect(
      await editor.getByRole('img', { name: 'Attached image', exact: true }).evaluate((el) => ({
        width: (el as HTMLImageElement).naturalWidth,
        height: (el as HTMLImageElement).naturalHeight,
      })),
    ).toEqual({ width: 64, height: 64 });
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    const text = await composer.inputValue();
    const [sent] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(sent.status()).toBe(202);
    expect(await sent.json()).toMatchObject({ state: 'consumed', dispatched: true, sessionId: id });
    const command = sent.request().postDataJSON();
    expect(command.selection).toEqual(f.first.request.selection);
    expect(command.runtime).toEqual(f.first.request.runtime);
    expect(command.workspace).toEqual({
      kind: 'ordinary',
      workspaceId: chat.eventStore.getSession(id)?.ordinaryWorkspaceId,
    });
    expect(command.payload).toMatchObject({
      text,
      images: [{ data: editedData, mediaType: 'image/png' }],
    });
    expect(chat.eventStore.getOrdinaryCommandAdmission(command.clientMsgId)).toMatchObject({
      state: 'consumed',
    });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(index + 1));
    const native = nativeSessions[index];
    await vi.waitFor(() =>
      expect(native.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1),
    );
    const nativeInput = native.rpc.request.mock.calls.find(([m]) => m === 'turn/start')![1]!.input;
    expect(nativeInput).toContainEqual({ type: 'image', url: edited });
    expect(JSON.stringify(nativeInput)).toContain(text);
    const reply = 'Synthetic assistant reply for ' + label + '.';
    native.lifecycle.onNotification('item/agentMessage/delta', {
      threadId: native.threadId,
      turnId: native.turnId,
      itemId: label,
      delta: reply,
    });
    native.lifecycle.onNotification('item/completed', {
      threadId: native.threadId,
      turnId: native.turnId,
      item: { type: 'agentMessage', id: label, text: reply },
    });
    native.lifecycle.onNotification('turn/completed', {
      threadId: native.threadId,
      turn: { id: native.turnId, status: 'completed' },
    });
    await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
    const draft = 'Keep this unsent ' + label + ' draft.';
    await composer.fill(draft);
    await page.getByRole('button', { name: 'Read aloud', exact: true }).last().click();
    await vi.waitFor(() =>
      expect(external.http.filter((r) => r.path === '/v1/synthesize')).toHaveLength(index + 1),
    );
    expect(external.http.filter((r) => r.path === '/v1/synthesize')[index].body).toMatchObject({
      text: reply,
      voice: 'synthetic-silence',
    });
    await page.waitForFunction(() => window.__s9Media.playbackStarts > 0);
    await page.getByRole('button', { name: 'Stop reading', exact: true }).click();
    await browserExpect(composer).toHaveValue(draft);
    const media = await page.evaluate(() => window.__s9Media);
    expect(media).toMatchObject({
      captures: 1,
      trackStops: 1,
      decoded: 1,
      playbackStarts: 1,
      unlockStarts: 1,
    });
    expect(media.playbackStops).toBeGreaterThan(0);
    const access = await (await h.http('/api/sessions/' + id + '/access')).json();
    expect(access).toMatchObject({
      sessionId: id,
      state: 'current',
      model: f.binding.model,
      mode: 'agent',
      grants: [],
      pending: [],
      skillCeiling: null,
      attachments: null,
      tools: null,
      limits: null,
    });
    await capture(label + '-edited-image-delivered-voice-complete');
    rows.push({
      label,
      sessionId: id,
      text,
      reply,
      draft,
      command,
      editedSha256: hash(editedData),
      originalSha256: hash(original),
      media,
      access,
    });
  }
  for (const [index, id] of ids.entries()) {
    await page.goto(front.origin + '/chat/' + id);
    await page.reload();
    await browserExpect(composer).toHaveValue(rows[index].draft);
    await browserExpect(page.getByText(rows[index].reply, { exact: true })).toBeVisible();
    await browserExpect(page.getByText(rows[1 - index].reply, { exact: true })).toHaveCount(0);
    const image = page.getByRole('img', { name: 'Attachment 1', exact: true });
    await browserExpect(image).toBeVisible();
    const retained = await image.getAttribute('src');
    expect(hash(retained!.split(',')[1])).toBe(rows[index].editedSha256);
    await capture(rows[index].label + '-reloaded-owned-history');
  }
  expect(nativeSessions).toHaveLength(2);
  for (const native of nativeSessions)
    expect(native.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1);
  expect(chat.eventStore.getSession(ids[0])?.ordinaryWorkspaceId).not.toBe(
    chat.eventStore.getSession(ids[1])?.ordinaryWorkspaceId,
  );
  expect(await api.links({ namespace: 'mitzo', conversationId: ids[0] })).toEqual([]);
  expect(await api.links({ namespace: 'mitzo', conversationId: ids[1] })).toHaveLength(1);
  expect(
    external.http.every((r) => ['/health', '/v1/voices', '/v1/synthesize'].includes(r.path)),
  ).toBe(true);
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'voice-image-observations.json'),
      JSON.stringify(
        {
          meta,
          rows,
          recordings: external.recordings,
          externalHttp: external.http,
          health: monitor.getSnapshot(),
          nativeLaunches: nativeSessions.length,
          pageErrors: h.pageErrors,
          realModelCalls: 0,
          limitations:
            'Bounded offline Chromium synthetic microphone/STT/TTS/native effects. No real device/provider/audio service qualification; replacement interrupt and guarded skills remain pending.',
        },
        null,
        2,
      ),
    );
}, 90_000);
