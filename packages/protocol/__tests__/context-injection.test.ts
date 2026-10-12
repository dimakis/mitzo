import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { splitContextPrompt } from '../src/context-injection.js';

const preamble =
  'The user has attached the following reference files for this message.\nUse them to inform your response.';
const prompt = `${preamble}\n\n<context name="Jira Essentials" source="jira_process/context/agent-routing.md">\nStrats means RHAISTRAT.\n</context>\n\n---CONTEXT_END---\nWhat state are my Strats in?`;

describe('context injection display projection', () => {
  it('separates the exact attached reference from the readable user prompt', () => {
    expect(splitContextPrompt(prompt)).toEqual({
      text: 'What state are my Strats in?',
      injections: [
        {
          name: 'Jira Essentials',
          source: 'jira_process/context/agent-routing.md',
          content: 'Strats means RHAISTRAT.',
        },
      ],
    });
  });

  it('retains separator-like content inside references and the actual user message', () => {
    const text =
      prompt.replace(
        'Strats means RHAISTRAT.',
        'Keep ---CONTEXT_END--- literal.\n</context> is an example.',
      ) + '\n---CONTEXT_END---\nmore user text';
    const result = splitContextPrompt(text)!;
    expect(result.injections[0].content).toBe(
      'Keep ---CONTEXT_END--- literal.\n</context> is an example.',
    );
    expect(result.text).toBe('What state are my Strats in?\n---CONTEXT_END---\nmore user text');
  });

  it('decodes escaped metadata once and preserves multiple complete references', () => {
    const text = prompt
      .replace('Jira Essentials', 'Jira &amp; &quot;fields&quot;')
      .replace(
        '\n\n---CONTEXT_END---',
        '\n\n<context name="Org" source="org.md">\nTeam map\n</context>\n\n---CONTEXT_END---',
      );
    expect(splitContextPrompt(text)).toEqual({
      text: 'What state are my Strats in?',
      injections: [
        {
          name: 'Jira & "fields"',
          source: 'jira_process/context/agent-routing.md',
          content: 'Strats means RHAISTRAT.',
        },
        { name: 'Org', source: 'org.md', content: 'Team map' },
      ],
    });
  });

  it('keeps the complete legacy prompt when an attached repository document contains envelope examples', () => {
    const document = readFileSync(
      new URL('../../../docs/design/context-blocks.md', import.meta.url),
      'utf8',
    );
    const text = `${preamble}\n\n<context name="Context design" source="docs/design/context-blocks.md">\n${document}\n</context>\n\n<context name="Org" source="org.md">\nTeam map\n</context>\n\n---CONTEXT_END---\nExplain this design.`;
    expect(splitContextPrompt(text)).toBeNull();
  });

  it('does not truncate a reference at a literal closing-tag and separator example', () => {
    const text = prompt.replace(
      'Strats means RHAISTRAT.',
      'Example:\n</context>\n\n---CONTEXT_END---\nExample question\nMore reference content.',
    );
    expect(splitContextPrompt(text)).toBeNull();
  });

  it('does not create extra references from a literal closing-tag and reference-header example', () => {
    const text = prompt.replace(
      'Strats means RHAISTRAT.',
      'Example:\n</context>\n\n<context name="Sample" source="example.md">\nExample body\n</context>\n\n---CONTEXT_END---\nExample question\nMore reference content.',
    );
    expect(splitContextPrompt(text)).toBeNull();
  });

  it('does not fabricate references from an example without its own context-end separator', () => {
    const text = prompt.replace(
      'Strats means RHAISTRAT.',
      'Intro\n</context>\n\n<context name="Example" source="example.md">\nExample body\n</context>\n\nDocument text after example',
    );
    expect(splitContextPrompt(text)).toBeNull();
  });

  it.each([
    'A user mentioned ---CONTEXT_END--- here.',
    '<context name="example" source="x">content</context>\n---CONTEXT_END---\nhello',
    `${preamble}\n\n<context name="Jira" source="x">\nmissing close\n---CONTEXT_END---\nhello`,
  ])('does not hide ordinary or incomplete user text', (text) => {
    expect(splitContextPrompt(text)).toBeNull();
  });
});
