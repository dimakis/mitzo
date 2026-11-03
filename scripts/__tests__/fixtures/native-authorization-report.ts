// Independent expected coverage for tests of the actual workflow validator.
// Keep report data fresh per case; never infer expected coverage from the
// validator being tested, which could silently accept a weakened inventory.
export const nativeAuthorityCases = [
  ['native-host-operator-lifetime.test.ts', 9],
  ['native-local-repository-preparation-registration-dispatch.test.ts', 4],
  ['native-local-repository-read-tools.test.ts', 14],
  ['native-reader-path-authorization.test.ts', 13],
  ['qualified-local-repository-materializer.test.ts', 2],
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
