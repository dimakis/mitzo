import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { setSkillPolicy, clearSkillPolicy, checkSkillPolicy } from '../src/skill-policy.js';
import type { SessionTransport } from '../src/session-transport.js';

function fakeTransport(): SessionTransport {
  return { send: () => {}, isOpen: () => true };
}

describe('skill-policy', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.register('client-1', {
      transport: fakeTransport(),
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
  });

  afterEach(() => {
    registry.dispose();
  });

  it('allows any tool when no policy is active', () => {
    expect(checkSkillPolicy(registry, 'client-1', 'Bash')).toBe('allow');
    expect(checkSkillPolicy(registry, 'client-1', 'Read')).toBe('allow');
  });

  it('allows tools listed in the policy', () => {
    setSkillPolicy(registry, 'client-1', ['Read', 'Grep']);
    expect(checkSkillPolicy(registry, 'client-1', 'Read')).toBe('allow');
    expect(checkSkillPolicy(registry, 'client-1', 'Grep')).toBe('allow');
  });

  it('denies tools not in the policy', () => {
    setSkillPolicy(registry, 'client-1', ['Read', 'Grep']);
    expect(checkSkillPolicy(registry, 'client-1', 'Bash')).toBe('deny');
    expect(checkSkillPolicy(registry, 'client-1', 'Write')).toBe('deny');
  });

  it('clearSkillPolicy removes restrictions', () => {
    setSkillPolicy(registry, 'client-1', ['Read']);
    clearSkillPolicy(registry, 'client-1');
    expect(checkSkillPolicy(registry, 'client-1', 'Bash')).toBe('allow');
  });

  it('returns allow for unknown clientId', () => {
    expect(checkSkillPolicy(registry, 'nonexistent', 'Bash')).toBe('allow');
  });

  it('is a no-op for unknown clientId on set/clear', () => {
    expect(() => setSkillPolicy(registry, 'nonexistent', ['Read'])).not.toThrow();
    expect(() => clearSkillPolicy(registry, 'nonexistent')).not.toThrow();
  });
});
