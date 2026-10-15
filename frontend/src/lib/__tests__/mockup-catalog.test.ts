import { describe, expect, it } from 'vitest';
import { collectMockups } from '../mockup-catalog';
import type { FinishedMessage } from '../../types/chat';
const message = (
  id: string,
  content: string,
  role: 'assistant' | 'user' = 'assistant',
): FinishedMessage => ({
  messageId: id,
  role,
  blocks: [{ blockId: id, blockType: 'text', content }],
});
describe('conversation mockup catalog', () => {
  it('groups named mockups by their full directory and orders numbered revisions newest first', () => {
    const items = collectMockups([
      message('one', '[Release checklist](/task/mockups/release/v001.html)'),
      message('two', '[Another design](/task/mockups/onboarding/v001.html)'),
      message('three', '[Release checklist](/task/mockups/release/v010.html)'),
      message('four', '[Release checklist](/task/mockups/release/v002.html)'),
      message('five', '[Latest again](/task/mockups/release/v010.html)'),
      message('six', '[Release checklist](/other/mockups/release/v001.html)'),
    ]);
    expect(items).toHaveLength(3);
    const release = items.find((item) => item.id === '/task/mockups/release')!;
    expect(release.title).toBe('Release checklist');
    expect(release.revisions.map((item) => item.number)).toEqual([10, 2, 1]);
    expect(release.revisions[0].messageId).toBe('five');
  });
  it('parses reference links and escaped paths, excluding code, user sources, remote URLs and tool results', () => {
    const items = collectMockups([
      message('user', '[Source](/mockups/user/v001.html)', 'user'),
      message(
        'agent',
        '[Draft][draft]\n\n[draft]: /task/mockups/hello%20world/v001.html\n\n`[Code](/fake.html)`\n\n```md\n[No](/fake2.html)\n```\n\n[Website](https://example.test/mock.html)\n\n[Not HTML](/task/file.md)',
      ),
      {
        messageId: 'tool',
        role: 'assistant',
        blocks: [
          {
            blockId: 't',
            blockType: 'tool_use',
            content: '[No](/tool.html)',
            toolResult: '[No](/tool2.html)',
          },
        ],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].revisions[0].path).toBe('/task/mockups/hello world/v001.html');
  });
  it('retains legacy HTML links separately and handles identical basenames in different directories', () => {
    const items = collectMockups([
      message(
        'a',
        '[First](/one/design.html)\n\n[Second](file-path://%2Ftwo%2Fdesign.html)\n\n[First again](/one/design.html)',
      ),
    ]);
    expect(items).toHaveLength(2);
    expect(
      items.every((item) => item.revisions.length === 1 && item.revisions[0].number === null),
    ).toBe(true);
  });
});
