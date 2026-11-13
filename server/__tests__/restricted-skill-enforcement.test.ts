import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionRegistry,
  buildPermissionHandler,
  setSkillPolicy,
  resolvePending,
} from '@mitzo/harness';
import * as worktree from '../../packages/harness/src/worktree-guard.js';
import { SkillRegistry } from '../skills.js';
import { resolveSlashCommand } from '../slash-commands.js';
import { ordinarySkillEntries, resolveOrdinarySkillPrompt } from '../ordinary-composer-skills.js';
import { buildSessionPermissionHooks } from '../session-permission-policy.js';
import { executableSkillResolution } from '../skill-runtime-support.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});
function skills(definitions: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'restricted-skills-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, metadata] of Object.entries(definitions)) {
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---\ndescription: Test skill\n${metadata}\n---\nDo the work`,
    );
  }
  return new SkillRegistry({ bundledDir: root });
}
function owner() {
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const send = vi.fn();
  registry.register('client', {
    transport: { send, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'auto',
    sessionAllowList: new Set(),
  });
  const decide = buildPermissionHandler('client', registry);
  const hook = buildSessionPermissionHooks(decide).PreToolUse![0].hooks[0];
  const run = (name: string, toolInput = {}) =>
    hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '',
        cwd: '',
        tool_name: name,
        tool_use_id: name,
        tool_input: toolInput,
      },
      name,
      { signal: new AbortController().signal },
    );
  return { registry, send, decide, run };
}

it('keeps unrestricted execution available and refuses empty and inherited ceilings at prompt admission', () => {
  const registry = skills({
    unrestricted: '',
    empty: 'allowed-tools: []',
    restricted: 'allowed-tools: [Read]',
    wrapper: 'requires-skills: [restricted]',
  });
  expect(
    executableSkillResolution(resolveSlashCommand('/unrestricted', registry, new Set())),
  ).toMatchObject({ type: 'skill', allowedTools: undefined });
  for (const name of ['empty', 'restricted', 'wrapper'])
    expect(
      executableSkillResolution(resolveSlashCommand(`/${name}`, registry, new Set())),
    ).toMatchObject({ type: 'error', message: expect.stringMatching(/tool restrictions/) });
});

it.each([{ root: undefined }, { root: ['Read', 'Write'] }])(
  'intersects dependency ceilings with root $root',
  ({ root }) => {
    const registry = skills({
      wrapper: `${root ? `allowed-tools: ${JSON.stringify(root)}\n` : ''}requires-skills: [middle]`,
      middle: 'requires-skills: [leaf]',
      leaf: 'allowed-tools: [Read, Grep]',
    });
    expect(resolveSlashCommand('/wrapper', registry, new Set())).toMatchObject({
      type: 'skill',
      allowedTools: root ? ['Read'] : ['Read', 'Grep'],
    });
  },
);

it('keeps an empty transitive intersection as deny-all at the actual SDK hook', async () => {
  const registry = skills({
    wrapper: 'allowed-tools: [Write]\nrequires-skills: [leaf]',
    leaf: 'allowed-tools: [Read]',
  });
  const resolved = resolveSlashCommand('/wrapper', registry, new Set());
  expect(resolved).toMatchObject({ type: 'skill', allowedTools: [] });
  if (resolved.type !== 'skill') throw Error('Expected a skill');
  const f = owner();
  setSkillPolicy(f.registry, 'client', resolved.allowedTools!);
  expect(await f.run('Read')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  'allowed-tools: {Read: true}',
  'allowed-tools: [Read, 42]',
  'allowed-tools: null',
  'allowed-tools: Read\nallowed-tools: Write',
  'allowed-tools: [Read, "Bash(git *)"]',
  'allowed-tools: "mcp__server__*"',
  'allowed-tools: [Read, {name: Write}]',
  'requires-skills: leaf',
  'requires-skills: [leaf, 42]',
])('refuses unsupported declarations before resolution: %s', (declaration) => {
  const registry = skills({ invalid: declaration, wrapper: 'requires-skills: [invalid]' });
  for (const name of ['invalid', 'wrapper']) {
    expect(resolveSlashCommand(`/${name}`, registry, new Set())).toMatchObject({ type: 'error' });
    expect(() => resolveOrdinarySkillPrompt(`/${name}`, registry)).toThrow();
    expect(
      ordinarySkillEntries(registry).find((entry) => entry.name === name)?.unavailableReason,
    ).toBeTruthy();
  }
});

it('enforces exact names for auto-approved and MCP tools through SDK PreToolUse', async () => {
  const f = owner();
  setSkillPolicy(f.registry, 'client', ['Read']);
  expect(await f.run('Read')).toMatchObject({
    hookSpecificOutput: { permissionDecision: 'allow' },
  });
  for (const name of ['Write', 'read', 'mcp__jira__search', 'InvokeIntegrationTool'])
    expect(await f.run(name)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  'Agent',
  'Task',
  'StartSession',
  'TelosCreateSession',
  'mcp__mitzo-connections__StartSession',
  'mcp__mitzo-connections__TelosCreateSession',
  'mcp__telos__TelosCreateSession',
])('refuses unqualified delegation despite an explicit %s entry', async (name) => {
  const f = owner();
  setSkillPolicy(f.registry, 'client', [name]);
  expect(await f.run(name)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(f.send).not.toHaveBeenCalled();
});

it('rechecks revocation after awaited workspace authorization before auto-allow', async () => {
  const f = owner();
  setSkillPolicy(f.registry, 'client', ['Read']);
  vi.spyOn(worktree, 'checkWorktreePolicy').mockImplementationOnce(async () => {
    setSkillPolicy(f.registry, 'client', []);
    return null;
  });
  expect(await f.run('Read')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

it('revalidates a pending approval against a changed ceiling', async () => {
  const f = owner();
  setSkillPolicy(f.registry, 'client', ['mcp__jira__search']);
  const pending = f.run('mcp__jira__search');
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  setSkillPolicy(f.registry, 'client', []);
  resolvePending(f.send.mock.calls[0][0].permId, 'once');
  expect(await pending).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});
