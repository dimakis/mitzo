import { describe, it, expect } from 'vitest';
import { sourceIcon, buildPrompt, buildTodoContext } from '../todo-utils';
import type { TodoItem } from '../../types/todo';

describe('sourceIcon', () => {
  it('returns GH for github', () => {
    expect(sourceIcon('github')).toBe('GH');
  });

  it('returns JR for jira', () => {
    expect(sourceIcon('jira')).toBe('JR');
  });

  it('returns GM for gmail', () => {
    expect(sourceIcon('gmail')).toBe('GM');
  });

  it('returns GD for gdocs', () => {
    expect(sourceIcon('gdocs')).toBe('GD');
  });

  it('returns first two chars uppercased for unknown types', () => {
    expect(sourceIcon('slack')).toBe('SL');
    expect(sourceIcon('confluence')).toBe('CO');
  });
});

const fullItem: TodoItem = {
  id: 'abc123',
  summary: 'Fix authentication middleware',
  profile: 'centaur',
  urgency: 0.75,
  starred: false,
  status: 'active',
  ageDays: 5,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  goalId: null,
  sources: [
    {
      type: 'github',
      url: 'https://github.com/dimakis/mitzo/issues/42',
      title: 'Auth middleware broken on refresh',
      author: 'octocat',
      snippet: 'The auth middleware fails to validate tokens after page refresh...',
    },
  ],
  links: [
    {
      type: 'design_doc',
      url: 'docs/auth-design.md',
      title: 'Authentication design',
      description: 'Durable auth decisions',
    },
  ],
  contextHints: {
    repos: ['dimakis/mitzo', 'dimakis/contexgin'],
    paths: ['server/auth.ts', 'server/permission-handler.ts'],
    issues: ['dimakis/mitzo#42'],
    docIds: ['1abc-doc-id'],
    people: ['dimakis'],
    jiraKeys: ['RHAIENG-1234'],
    keywords: ['auth', 'jwt'],
    taskHint: 'Fix token validation in auth middleware after page refresh',
  },
};

describe('buildPrompt', () => {
  it('includes summary, source, context hints, and task hint', () => {
    const prompt = buildPrompt(fullItem);

    expect(prompt).toContain('**Fix authentication middleware**');
    expect(prompt).toContain('Source: https://github.com/dimakis/mitzo/issues/42');
    expect(prompt).toContain('The auth middleware fails to validate tokens');
    expect(prompt).toContain('Repos: dimakis/mitzo, dimakis/contexgin');
    expect(prompt).toContain('Issues: dimakis/mitzo#42');
    expect(prompt).toContain('Files: server/auth.ts, server/permission-handler.ts');
    expect(prompt).toContain('Jira: RHAIENG-1234');
    expect(prompt).toContain('Keywords: auth, jwt');
    expect(prompt).toContain('Fix token validation in auth middleware after page refresh');
    expect(prompt).toContain('Authentication design: docs/auth-design.md');
    expect(prompt).toContain('Start by reading the relevant code');
  });

  it('includes durable links in session context', () => {
    expect(buildTodoContext(fullItem)).toContain(
      'Link: Authentication design (design_doc)\n  URL: docs/auth-design.md',
    );
  });

  it('handles item with no sources or context', () => {
    const minimalItem: TodoItem = {
      ...fullItem,
      sources: [],
      contextHints: {
        repos: [],
        paths: [],
        issues: [],
        docIds: [],
        people: [],
        jiraKeys: [],
        keywords: [],
        taskHint: '',
      },
    };

    const prompt = buildPrompt(minimalItem);
    expect(prompt).toContain('**Fix authentication middleware**');
    expect(prompt).not.toContain('Context:');
    expect(prompt).toContain('Start by reading the relevant code');
  });

  it('handles source with no snippet or URL', () => {
    const noSnippetItem: TodoItem = {
      ...fullItem,
      sources: [
        {
          type: 'jira',
          url: '',
          title: 'Some Jira ticket',
          author: 'someone',
          snippet: '',
        },
      ],
    };

    const prompt = buildPrompt(noSnippetItem);
    expect(prompt).toContain('**Fix authentication middleware**');
    expect(prompt).not.toContain('Source:');
    expect(prompt).toContain('Repos:');
  });

  it('starts a session with the outcome contract and next milestone', () => {
    const structured: TodoItem = {
      ...fullItem,
      intent: 'Signed-in people remain authenticated after refresh.',
      rationale: 'Unexpected sign-outs interrupt every workflow.',
      acceptanceCriteria: ['Refresh preserves the active session'],
      children: [
        {
          ...fullItem,
          id: 'done',
          summary: 'Reproduce the bug',
          status: 'completed',
          children: [],
        },
        { ...fullItem, id: 'next', summary: 'Add the regression test', children: [] },
      ],
    };

    const prompt = buildPrompt(structured);

    expect(prompt).toContain('Outcome:\nSigned-in people remain authenticated after refresh.');
    expect(prompt).toContain('Why it matters:\nUnexpected sign-outs interrupt every workflow.');
    expect(prompt).toContain('Done when:\n- Refresh preserves the active session');
    expect(prompt).toContain('Next milestone:\n- Add the regression test');
  });
});
