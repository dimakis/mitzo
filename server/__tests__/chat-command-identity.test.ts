import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { claimChatCommand } from '../reasoning-command-admission.js';

describe('global ingress identity', () => {
  it('survives reopen and shares claims across store connections without creating an execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-claim-'));
    const path = join(dir, 'events.db');
    const first = new EventStore(path);
    const other = new EventStore(path);
    const message = { clientMsgId: 'c', sessionId: null, prompt: 'ordinary task', model: 'm' };
    try {
      claimChatCommand(first, message);
      claimChatCommand(other, {
        model: 'm',
        prompt: 'ordinary task',
        sessionId: null,
        clientMsgId: 'c',
      });
      expect(() => claimChatCommand(other, { ...message, prompt: '/fuse task' })).toThrow(
        /different request/,
      );
      expect(first.getSendCommand('c')).toBeUndefined();
      expect(first.getExecutionAdmission('s', 'c')).toBeUndefined();
    } finally {
      first.close();
      other.close();
    }
    const reopened = new EventStore(path);
    try {
      claimChatCommand(reopened, message);
      expect(() => claimChatCommand(reopened, { ...message, model: 'other' })).toThrow(
        /different request/,
      );
      claimChatCommand(reopened, { ...message, clientMsgId: 'new', prompt: '/fuse task' });
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
