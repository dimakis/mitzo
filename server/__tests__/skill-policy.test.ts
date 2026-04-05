import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { checkSkillPolicy, setSkillPolicy, clearSkillPolicy } from '../skill-policy.js';
import { buildPermissionHandler } from '../permission-handler.js';

describe('skill policy', () => {
  let registry: SessionRegistry;
  const clientId = 'test-client';

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.register(clientId, {
      ws: { readyState: 1, OPEN: 1 } as never,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('setSkillPolicy / clearSkillPolicy', () => {
    it('sets allowed-tools restriction on the session', () => {
      setSkillPolicy(registry, clientId, ['Read', 'Glob', 'Grep']);
      const session = registry.get(clientId)!;
      expect(session.activeSkillPolicy).toEqual(new Set(['Read', 'Glob', 'Grep']));
    });

    it('clears skill policy from the session', () => {
      setSkillPolicy(registry, clientId, ['Read']);
      clearSkillPolicy(registry, clientId);
      const session = registry.get(clientId)!;
      expect(session.activeSkillPolicy).toBeNull();
    });
  });

  describe('checkSkillPolicy', () => {
    it('allows tool when no skill policy is active', () => {
      const result = checkSkillPolicy(registry, clientId, 'Bash');
      expect(result).toBe('allow');
    });

    it('allows tool that is in the skill allowed-tools list', () => {
      setSkillPolicy(registry, clientId, ['Read', 'Glob', 'Grep']);
      expect(checkSkillPolicy(registry, clientId, 'Read')).toBe('allow');
      expect(checkSkillPolicy(registry, clientId, 'Glob')).toBe('allow');
    });

    it('denies tool that is NOT in the skill allowed-tools list', () => {
      setSkillPolicy(registry, clientId, ['Read', 'Glob', 'Grep']);
      expect(checkSkillPolicy(registry, clientId, 'Bash')).toBe('deny');
      expect(checkSkillPolicy(registry, clientId, 'Write')).toBe('deny');
      expect(checkSkillPolicy(registry, clientId, 'Edit')).toBe('deny');
    });

    it('denies safe-tier tool when not in skill allowed-tools', () => {
      // This tests that skill restrictions are checked BEFORE shouldAutoAllow
      setSkillPolicy(registry, clientId, ['Bash']);
      expect(checkSkillPolicy(registry, clientId, 'Read')).toBe('deny');
    });

    it('denies MCP tools when skill policy is active', () => {
      setSkillPolicy(registry, clientId, ['Read', 'Glob']);
      expect(checkSkillPolicy(registry, clientId, 'mcp__jira__search')).toBe('deny');
    });

    it('allows MCP tools when no skill policy is active', () => {
      expect(checkSkillPolicy(registry, clientId, 'mcp__jira__search')).toBe('allow');
    });

    it('returns allow when session not found', () => {
      expect(checkSkillPolicy(registry, 'nonexistent', 'Read')).toBe('allow');
    });
  });

  describe('per-message independence', () => {
    it('plain message after skill invocation has no restrictions', () => {
      // Simulate: user sends /simplify → policy set
      setSkillPolicy(registry, clientId, ['Read', 'Glob']);
      expect(checkSkillPolicy(registry, clientId, 'Bash')).toBe('deny');

      // Simulate: user sends plain text → policy cleared
      clearSkillPolicy(registry, clientId);
      expect(checkSkillPolicy(registry, clientId, 'Bash')).toBe('allow');
    });
  });

  describe('integration with permission handler', () => {
    it('skill policy denies Bash even in agent mode via buildPermissionHandler', async () => {
      // Set a read-only skill policy
      setSkillPolicy(registry, clientId, ['Read', 'Glob', 'Grep']);

      const handler = buildPermissionHandler(clientId, registry);
      const ac = new AbortController();
      const result = await handler(
        'Bash',
        { command: 'ls' },
        {
          signal: ac.signal,
          toolUseID: 'test-tool-1',
        },
      );

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('skill policy');
    });

    it('allows Read through permission handler when in skill policy', async () => {
      setSkillPolicy(registry, clientId, ['Read', 'Glob', 'Grep']);

      const handler = buildPermissionHandler(clientId, registry);
      const ac = new AbortController();
      const result = await handler(
        'Read',
        { file_path: '/tmp/test' },
        {
          signal: ac.signal,
          toolUseID: 'test-tool-2',
        },
      );

      // Read is safe-tier AND in skill policy — should be allowed
      expect(result.behavior).toBe('allow');
    });
  });

  describe('mode interaction', () => {
    it('skill cannot grant tools beyond what the mode allows', () => {
      // Register an ask-mode session
      const askClientId = 'ask-client';
      registry.register(askClientId, {
        ws: { readyState: 1, OPEN: 1 } as never,
        abortController: new AbortController(),
        mode: 'ask',
        sessionAllowList: new Set(),
      });

      // Even if skill lists Bash, ask mode should not grant shell
      // This is enforced at the shouldAutoAllow level, not here
      // Skill policy only RESTRICTS, never EXPANDS
      setSkillPolicy(registry, askClientId, ['Read', 'Bash']);
      // Bash is in the skill list, so skill policy allows it
      // But the mode check (shouldAutoAllow) would still deny it in ask mode
      // checkSkillPolicy only checks the skill filter, not the mode
      expect(checkSkillPolicy(registry, askClientId, 'Bash')).toBe('allow');
      // Read is allowed by both skill and mode
      expect(checkSkillPolicy(registry, askClientId, 'Read')).toBe('allow');
      // Write is not in skill list, denied by skill policy
      expect(checkSkillPolicy(registry, askClientId, 'Write')).toBe('deny');
    });
  });
});
