// Independent expected coverage for tests of the actual workflow validator.
// Keep report data fresh per case; never infer expected coverage from the
// validator being tested, which could silently accept a weakened inventory.
export const nativeAuthorityCases = [
  ['native-host-operator-lifetime.test.ts', 9],
  ['native-local-repository-preparation-registration-dispatch.test.ts', 4],
  ['native-local-repository-read-tools.test.ts', 17],
  ['native-reader-path-authorization.test.ts', 14],
  ['qualified-local-repository-materializer.test.ts', 2],
  ['qualified-local-repository-operation-owner.test.ts', 1],
] as const;

export type NativeAuthorityReport = {
  success: boolean;
  testResults: Array<{
    name: string;
    assertionResults: Array<{ fullName: string; status: string }>;
  }>;
};

export function completeNativeAuthorityReport(): NativeAuthorityReport {
  return {
    success: true,
    testResults: nativeAuthorityCases.map(([file, count]) => ({
      name: '/fixture/server/__tests__/' + file,
      assertionResults: Array.from({ length: count }, (_, index) => ({
        fullName: file + ' required case ' + index,
        status: 'passed',
      })),
    })),
  };
}

export const nativeWorkerBoundaryCases = [
  [
    'native-exclusive-file-batch.test.ts',
    'publishes six exact files with one launch and two original full-owner checks',
  ],
  [
    'native-exclusive-file-batch.test.ts',
    'retains original full-owner refusal at batch gate 1 without replay',
  ],
  [
    'native-exclusive-file-batch.test.ts',
    'retains original full-owner refusal at batch gate 2 without replay',
  ],
  [
    'native-exclusive-file.test.ts',
    'revalidates the original owner after joined worker cleanup rejects, retaining uncertain published bytes',
  ],
  [
    'prepared-repository-native-read.test.ts',
    'reads through the actual fresh barrier and same existing SRT helper with no source write root',
  ],
  [
    'prepared-repository-workspace-owner.test.ts',
    'owns one linked topology helper and exactly entry/post-effect credential checks',
  ],
  [
    'prepared-repository-workspace-owner.test.ts',
    'owns one standalone topology helper and exactly entry/post-effect credential checks',
  ],
] as const;

export function completeNativeWorkerBoundaryReport(): NativeAuthorityReport {
  return {
    success: true,
    testResults: [...new Set(nativeWorkerBoundaryCases.map(([file]) => file))].map((file) => ({
      name: '/fixture/server/__tests__/' + file,
      assertionResults: nativeWorkerBoundaryCases
        .filter(([name]) => name === file)
        .map(([, fullName]) => ({ fullName, status: 'passed' })),
    })),
  };
}
