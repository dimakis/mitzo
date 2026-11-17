import { describe, expect, it } from 'vitest';
import { specialistDiagnostic } from '../specialist-consultation-diagnostics.js';

describe('specialistDiagnostic', () => {
  it('names a missing repository source instead of a generic failure', () => {
    const diagnostic = specialistDiagnostic(
      Error('Repository source is not configured for this specialist account'),
    );
    expect(diagnostic.code).toBe('repository_source_missing');
    expect(diagnostic.message).toMatch(/repository source/i);
    expect(diagnostic.message).toMatch(/no other account/i);
  });

  it('keeps unknown causes generic', () => {
    expect(specialistDiagnostic(Error('unexpected')).code).toBe('specialist_tool_failed');
  });
});
