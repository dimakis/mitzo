import { afterEach, expect, it } from 'vitest';
import {
  createAcceptanceFixture,
  cleanupAcceptanceFixtures,
} from '../../server/__tests__/fixtures/symposium-acceptance.js';

afterEach(cleanupAcceptanceFixtures);

// Required milestone regression. Run explicitly; a red result is an OPEN GAP,
// never a skipped/pending/pass or an expected-failure acceptance claim.
it('retains an authorized finalized reply for the silent reader before its next explicit turn', async () => {
  const f = createAcceptanceFixture();
  f.policy('architect', true, false);
  const prompt = f.message('Architect must read the reviewer answer later', ['reviewer']);
  expect(prompt.readers).toContain('architect');
  const reply = f.finalizedReply(prompt);
  expect(reply.author).toEqual({ sessionId: 'reviewer' });
  expect(reply.readers, 'Authorized readers must retain replies as well as prompts').toContain(
    'architect',
  );
  expect(reply.responders).toEqual([]);
  expect(reply.deliveries).toEqual([
    expect.objectContaining({
      sessionId: 'architect',
      purpose: 'context',
      status: 'pending',
      commandId: null,
    }),
  ]);
  expect(f.samplingRequests()).toEqual([]);
  f.reopen();
  const explicit = f.message('Now critique the answer explicitly', ['architect']);
  const runtime = f.runtime('architect', [
    f.ref(prompt, 'architect'),
    f.ref(reply, 'architect'),
    f.ref(explicit, 'architect'),
  ]);
  await runtime.driver.initialize();
  expect(f.samplingRequests()).toEqual([]);
  await runtime.driver.send({ id: 'initial-architect', prompt: explicit.text });
  const turn = JSON.stringify(runtime.requests.find((row) => row.method === 'turn/start')!.params);
  expect(turn).toContain(prompt.text);
  expect(turn).toContain(reply.text);
  expect(turn.indexOf(prompt.text)).toBeLessThan(turn.indexOf(reply.text));
  expect(f.samplingRequests()).toHaveLength(1);
});
