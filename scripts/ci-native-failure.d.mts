export function nativeCiFailure(
  stage: string,
  error: unknown,
): {
  diagnostic: { code: string; stage: string; errorClass: string; source: string };
  annotation: string;
};
export function syntheticKernelCommandReport(
  profile: string,
  result: unknown,
  fixtureRoot: string,
): { profile: string; exitCode: number | null; stderr: string };
