import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github-dark-dimmed.min.css';
import { MemoryRouter } from 'react-router-dom';
import { ToolPill } from '../../frontend/src/components/ToolPill';
import { getRawInput, summarizeToolInput } from '../../packages/protocol/src/tool-summary';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/code-block.css';

const result = JSON.stringify(
  Array.from({ length: 23 }, (_, i) => ({
    sha: '9c65d8ef97f7169b22dc612f66907f2709bee0000',
    commit: {
      message: `Improve tool result readability ${i + 1}`,
      author: { name: 'Example contributor', date: '2026-11-03T23:22:00Z' },
    },
    html_url: `https://github.com/example/project/commit/${'a'.repeat(120)}`,
    verified: false,
  })),
);
const patch = {
  changes: [
    {
      path: '/workspace/server/session-specialist-tools.ts',
      kind: { type: 'update' },
      diff: '@@ -1 +1 @@\n-const old = 1;\n+const next = 2;',
    },
    {
      path: '/workspace/tests/new-file.ts',
      kind: { type: 'add' },
      diff: '+export const example = true;',
    },
  ],
};
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <main>
      <ToolPill
        block={{
          blockId: 'patch',
          blockType: 'tool_use',
          content: '',
          toolName: 'ApplyPatch',
          toolInput: summarizeToolInput('ApplyPatch', patch),
          rawInput: getRawInput('ApplyPatch', patch),
          toolResult: 'Applied 2 file change(s).',
        }}
      />
      <ToolPill
        block={{
          blockId: 'github',
          blockType: 'tool_use',
          content: '',
          toolName: 'GitHubRead',
          toolInput:
            '{"endpoint":"/repos/example/project/commits?sha=feature%2Freadable-results&per_page=23","view":"full"}',
          toolResult: result,
        }}
      />
      <ToolPill
        block={{
          blockId: 'empty',
          blockType: 'tool_use',
          content: '',
          toolName: 'Empty result',
          toolResult: '[]',
        }}
      />
      <ToolPill
        block={{
          blockId: 'error',
          blockType: 'tool_use',
          content: '',
          toolName: 'Failed lookup',
          toolError: true,
          toolResult: 'Could not load results.\nTry again after reconnecting.',
        }}
      />
      <ToolPill
        block={{
          blockId: 'loading',
          blockType: 'tool_use',
          content: '',
          toolName: 'Pending lookup',
        }}
      />
      <textarea aria-label="Draft" defaultValue="Keep my draft" />
    </main>
  </MemoryRouter>,
);
