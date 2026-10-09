import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  OpenAIEnrollmentKeychainCredentials,
  openAIEnrollmentCredentialReference,
} from '../openai-account-enrollment-keychain.js';
it('creates a new unique item through stdin and never updates an existing item', async () => {
  const run = vi.fn(async (_stdin: string, _signal: AbortSignal) => '{"ok":true}');
  const keychain = new OpenAIEnrollmentKeychainCredentials(run);
  const id = randomUUID();
  expect(await keychain.create(id, 'sk-private', AbortSignal.timeout(1000))).toEqual(
    openAIEnrollmentCredentialReference(id),
  );
  const request = JSON.parse(run.mock.calls[0][0] as string);
  expect(request).toMatchObject({
    value: 'sk-private',
    version: id,
    service: 'mitzo.openai.enrollment.' + id,
    account: 'api-key',
  });
});
it('refuses an uncertain native creation without leaking its diagnostic or reusing a reference', async () => {
  const run = vi.fn(async () => {
    throw new Error('Bearer sk-private');
  });
  const keychain = new OpenAIEnrollmentKeychainCredentials(run);
  await expect(
    keychain.create(randomUUID(), 'sk-private', AbortSignal.timeout(1000)),
  ).rejects.toThrow('OpenAI Keychain creation could not be confirmed');
  expect(run).toHaveBeenCalledOnce();
  expect(() => openAIEnrollmentCredentialReference('../existing-item')).toThrow();
});
