import { expect, it } from 'vitest';
import { uncertainOperationsNotice } from '../uncertain-operations-notice.js';

it('names a plain original request ID as-is', () => {
  const text = uncertainOperationsNotice([{ tool: 'TelosCreateChild', requestId: 'req-9' }]);
  expect(text).toContain('TelosCreateChild (request ID req-9)');
  expect(text).toContain('same request ID');
});

it('keeps request IDs that owning schemas accept with spaces, quoted for exact reuse', () => {
  const text = uncertainOperationsNotice([
    { tool: 'TelosSaveArtifact', requestId: 'save draft 1' },
    { tool: 'TelosUpdateItem', requestId: 'line\nbreak "quoted"' },
  ]);
  expect(text).toContain('TelosSaveArtifact (request ID "save draft 1")');
  // Control characters and quotes are escaped and cannot reshape the notice.
  expect(text).toContain('TelosUpdateItem (request ID "line\\nbreak \\"quoted\\"")');
  expect(text).not.toContain('no request ID');
});

it('falls back to the generic notice for malformed descriptors', () => {
  expect(uncertainOperationsNotice([])).toBeUndefined();
  expect(uncertainOperationsNotice([{ tool: 'Bash', requestId: 'x'.repeat(201) }])).toBeUndefined();
  expect(uncertainOperationsNotice('nope')).toBeUndefined();
});
