import { expect, it, vi } from 'vitest';
import { GoogleWorkspaceManagement } from '../google-workspace-management.js';
import { googleReadFixture } from './fixtures/google-workspace-read.js';
import {
  googleWorkspaceReadTarget,
  readGoogleWorkspaceResponse,
} from '../google-workspace-read.js';

it('keeps credentials private and binds the approved account and reviewed policy to the read', async () => {
  const f = googleReadFixture();
  const service = new GoogleWorkspaceManagement(f.options);
  const signal = new AbortController().signal;
  const prepared = await service.prepareRead(
    { operation: 'drive.export', fileId: 'document', mimeType: 'text/plain' },
    signal,
  );
  expect(prepared.email).toBe('fixture@example.test');
  expect(JSON.stringify(prepared)).not.toContain('SECRET');
  expect(f.readRequest).not.toHaveBeenCalled();
  const guard = vi.fn();
  expect(await prepared.read(guard)).toBe('Google document content from the approved read');
  expect(guard).toHaveBeenCalled();
  expect(f.readRequest).toHaveBeenCalledWith(
    'https://www.googleapis.com/drive/v3/files/document/export?mimeType=text%2Fplain',
    expect.objectContaining({ signal, headers: { Authorization: 'Bearer SECRET_ACCESS' } }),
  );
});

it('rejects provider replacement and policy drift after approval before requesting content', async () => {
  for (const drift of ['identity', 'policy']) {
    const f = googleReadFixture();
    const service = new GoogleWorkspaceManagement(f.options);
    const prepared = await service.prepareRead(
      { operation: 'docs.get', documentId: 'document' },
      new AbortController().signal,
    );
    if (drift === 'identity')
      f.run.mockResolvedValueOnce(
        JSON.stringify([
          {
            id: 'replacement',
            name: 'google-workspace',
            workspace: 'default',
            type: 'mitzo-google-workspace-spike',
            resource_version: 9,
          },
        ]),
      );
    else
      f.run.mockImplementation(async (args) =>
        args[1] === 'list'
          ? JSON.stringify([
              {
                id: 'google-id',
                name: 'google-workspace',
                workspace: 'default',
                type: 'mitzo-google-workspace-spike',
                resource_version: 9,
              },
            ])
          : '{}',
      );
    await expect(prepared.read(async () => {})).rejects.toThrow();
    expect(f.readRequest).not.toHaveBeenCalled();
  }
});

it('does no authentication or provider work for invalid operations and paths', async () => {
  const f = googleReadFixture();
  const service = new GoogleWorkspaceManagement(f.options);
  for (const input of [
    { operation: 'drive.export', fileId: '../about', mimeType: 'text/plain' },
    { operation: 'drive.export', fileId: 'https://attacker.test', mimeType: 'text/plain' },
    { operation: 'drive.export', fileId: 'document', mimeType: 'application/octet-stream' },
    { operation: 'drive.delete', fileId: 'document' },
    { operation: 'docs.get', documentId: 'document', headers: { Authorization: 'evil' } },
  ])
    await expect(service.prepareRead(input, new AbortController().signal)).rejects.toThrow();
  expect(f.exportCredentials).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

it('refuses a retired runtime or cancelled read without sending credentials', async () => {
  const f = googleReadFixture();
  const service = new GoogleWorkspaceManagement(f.options);
  const abort = new AbortController();
  const prepared = await service.prepareRead(
    { operation: 'docs.get', documentId: 'document' },
    abort.signal,
  );
  await expect(
    prepared.read(async () => {
      throw Error('retired');
    }),
  ).rejects.toThrow();
  abort.abort();
  await expect(prepared.read(async () => {})).rejects.toThrow();
  expect(f.readRequest).not.toHaveBeenCalled();
});

it('bounds response bytes, rejects redirects and never returns Google error bodies', async () => {
  const signal = new AbortController().signal;
  await expect(
    readGoogleWorkspaceResponse(new Response('SECRET_ERROR', { status: 403 }), signal),
  ).rejects.toThrow('Google read failed');
  await expect(
    readGoogleWorkspaceResponse(new Response('redirect', { status: 302 }), signal),
  ).rejects.toThrow();
  await expect(
    readGoogleWorkspaceResponse(new Response('x'.repeat(2 * 1024 * 1024 + 1)), signal),
  ).rejects.toThrow('Google response is too large');
  expect(await readGoogleWorkspaceResponse(new Response('document text'), signal)).toBe(
    'document text',
  );
});

it('constructs only fixed Google read URLs with bounded parameters', () => {
  for (const input of [
    { operation: 'drive.list', query: "name contains 'notes'", pageSize: 10 },
    { operation: 'drive.get', fileId: 'document' },
    { operation: 'docs.get', documentId: 'document' },
    { operation: 'sheets.get', spreadsheetId: 'sheet', ranges: ['A1:D20'] },
    { operation: 'slides.get', presentationId: 'slides' },
    {
      operation: 'calendar.list',
      calendarId: 'primary',
      timeMin: '2026-10-30T00:00:00Z',
      maxResults: 10,
    },
  ])
    expect(googleWorkspaceReadTarget(input).url).toMatch(
      /^https:\/\/(www|docs|sheets|slides)\.googleapis\.com\//,
    );
  expect(() => googleWorkspaceReadTarget({ operation: 'drive.list', pageSize: 1000 })).toThrow();
});

it('cancels a stalled response body promptly when the original read is aborted', async () => {
  const abort = new AbortController();
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream({ cancel: cancelled }));
  const pending = readGoogleWorkspaceResponse(response, abort.signal).then(
    () => 'success',
    () => 'cancelled',
  );
  abort.abort();
  expect(
    await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('stalled'), 100)),
    ]),
  ).toBe('cancelled');
  expect(cancelled).toHaveBeenCalled();
});

it('withholds content when the provider is revoked while the Google HTTP read is in flight', async () => {
  for (const replacement of ['removed', 'replaced', 'policy']) {
    const f = googleReadFixture();
    const service = new GoogleWorkspaceManagement(f.options);
    const prepared = await service.prepareRead(
      { operation: 'docs.get', documentId: 'document' },
      new AbortController().signal,
    );
    f.readRequest.mockImplementationOnce(async () => {
      if (replacement === 'removed') f.run.mockResolvedValue('[]');
      else if (replacement === 'replaced')
        f.run.mockImplementation(async (args) =>
          args[1] === 'list'
            ? JSON.stringify([
                {
                  id: 'replacement',
                  name: 'google-workspace',
                  workspace: 'default',
                  type: 'mitzo-google-workspace-spike',
                  resource_version: 9,
                },
              ])
            : JSON.stringify(f.profile),
        );
      else
        f.run.mockImplementation(async (args) =>
          args[1] === 'list'
            ? JSON.stringify([
                {
                  id: 'google-id',
                  name: 'google-workspace',
                  workspace: 'default',
                  type: 'mitzo-google-workspace-spike',
                  resource_version: 9,
                },
              ])
            : '{}',
        );
      return 'Content must not be delivered after provider revocation';
    });
    await expect(prepared.read(async () => {})).rejects.toThrow();
  }
});
