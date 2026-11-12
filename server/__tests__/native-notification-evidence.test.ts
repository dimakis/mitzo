import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('uploads failed native fixture evidence and successful phase timings immediately after its owner', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const native = workflow.split('\n  native:')[1].split(/\n {2}[A-Za-z0-9_-]+:/)[0];
  expect(native).toContain('id: native-notification');
  expect(native).toContain('--diagnostics-dir test-results/native-notification');
  const smoke = native.indexOf('- name: Build iPhone app with Watch companion');
  expect(smoke).toBeGreaterThan(0);
  const upload = native.indexOf('- name: Retain native notification failure evidence');
  expect(upload).toBeGreaterThan(smoke);
  expect(native.slice(smoke, upload).match(/- name:/g)).toHaveLength(1);
  const evidence = native.slice(upload);
  // Always includes failure/cancellation evidence and now successful timing logs.
  expect(evidence).toContain('if: always()');
  expect(native.slice(smoke, upload)).toContain('set -o pipefail');
  expect(native.slice(smoke, upload)).toContain('scripts/ci-native-candidate.py');
  expect(evidence).toContain('uses: actions/upload-artifact@v7');
  expect(evidence).toContain(
    'name: native-notification-failure-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  expect(evidence).toContain('path: test-results/native-notification/');
  expect(evidence).toContain('retention-days: 7');
  expect(evidence).not.toContain('include-hidden-files: true');
  expect(native).toContain('contents: read');
  expect(native).not.toContain('continue-on-error: true');
});
