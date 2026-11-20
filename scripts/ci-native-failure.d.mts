export function nativeCiFailure(
  stage: string,
  error: unknown,
): {
  diagnostic: { code: string; stage: string; errorClass: string; source: string };
  annotation: string;
};
