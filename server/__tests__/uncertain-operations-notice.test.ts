import { expect, it } from 'vitest';
import { uncertainOperationsNotice } from '../uncertain-operations-notice.js';

it('names a plain original request ID as-is', () => {
  const text = uncertainOperationsNotice([{ tool: 'TelosCreateChild', requestId: 'req-9' }], 1);
  expect(text).toContain('TelosCreateChild (request ID req-9)');
  expect(text).toContain('same request ID');
  expect(text).not.toContain('unidentified');
});

it('keeps request IDs that owning schemas accept with spaces, quoted for exact reuse', () => {
  const text = uncertainOperationsNotice(
    [
      { tool: 'TelosSaveArtifact', requestId: 'save draft 1' },
      { tool: 'TelosUpdateItem', requestId: 'line\nbreak "quoted"' },
    ],
    2,
  );
  expect(text).toContain('TelosSaveArtifact (request ID "save draft 1")');
  // Control characters and quotes are escaped and cannot reshape the notice.
  expect(text).toContain('TelosUpdateItem (request ID "line\\nbreak \\"quoted\\"")');
  expect(text).not.toContain('no request ID');
});

it('counts unidentified uncertain operations instead of implying the list is complete', () => {
  const text = uncertainOperationsNotice([{ tool: 'TelosCreateChild', requestId: 'req-1' }], 3);
  expect(text).toMatch(
    /^Outcome unknown for: TelosCreateChild \(request ID req-1\), and 2 other unidentified operations\. They may or may not/,
  );
  // Reading state comes first because unnamed operations cannot be retried by ID.
  expect(text).toContain('read the current state before repeating anything');
  expect(text).toContain('Re-run a named call only with its same request ID');
});

it('falls back to the generic notice when the list or its total is not trustworthy', () => {
  expect(uncertainOperationsNotice([], 1)).toBeUndefined();
  expect(
    uncertainOperationsNotice([{ tool: 'Bash', requestId: 'x'.repeat(201) }], 1),
  ).toBeUndefined();
  expect(uncertainOperationsNotice('nope', 1)).toBeUndefined();
  const listed = [{ tool: 'TelosCreateChild', requestId: 'req-1' }];
  expect(uncertainOperationsNotice(listed, undefined)).toBeUndefined();
  expect(uncertainOperationsNotice(listed, 0)).toBeUndefined();
  expect(uncertainOperationsNotice(listed, 1.5)).toBeUndefined();
});
