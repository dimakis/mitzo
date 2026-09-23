import { describe, expect, it } from 'vitest';
import { HTML_ARTIFACT_INSTRUCTIONS } from '../html-artifacts.js';

describe('HTML artifact instructions', () => {
  it('steers visual prototypes to renderable workspace HTML instead of Canvas files', () => {
    expect(HTML_ARTIFACT_INSTRUCTIONS).toContain('self-contained .html');
    expect(HTML_ARTIFACT_INSTRUCTIONS).toContain('Do not create Cursor or Canvas artifacts');
    expect(HTML_ARTIFACT_INSTRUCTIONS).toContain('link the file path');
  });
});
