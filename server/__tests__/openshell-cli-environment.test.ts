import { describe, expect, it } from 'vitest';
import { validateOpenShellCliEnvironment } from '../openshell-cli-environment.js';
const valid = { HOME: '/private/host', XDG_CONFIG_HOME: '/private/config', PATH: '/usr/bin:/bin' };
describe('private OpenShell management environment', () => {
  it('copies only validated non-secret explicit paths', () => {
    expect(validateOpenShellCliEnvironment(valid)).toEqual(valid);
    expect(validateOpenShellCliEnvironment(valid)).not.toBe(valid);
  });
  it.each([
    {},
    { ...valid, HOME: 'relative' },
    { ...valid, PATH: '' },
    { ...valid, XDG_CONFIG_HOME: '/config\nother' },
    { ...valid, OPENAI_API_KEY: 'secret' },
    { ...valid, OPENSHELL_GATEWAY: 'legacy' },
  ])('rejects incomplete, ambient or credential-bearing routing %#', (value) => {
    expect(() => validateOpenShellCliEnvironment(value)).toThrow(/environment/);
  });
});
