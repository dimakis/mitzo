import { Capacitor } from '@capacitor/core';
import { NativeBiometric, BiometryType, AccessControl } from '@capgo/capacitor-native-biometric';
import { saveTokenToWatch } from './watch-auth';
import {
  getApiBaseUrl,
  getStoredAuthToken,
  isLogoutPending,
  loginSucceeded,
  markAuthLost,
} from './api-fetch';

const SERVER = 'com.mitzo.app';
const PASSPHRASE_KEY = `${SERVER}.biometric-passphrase`;
function passphraseKey(apiBaseUrl: string): string {
  return apiBaseUrl ? `${PASSPHRASE_KEY}:${encodeURIComponent(apiBaseUrl)}` : PASSPHRASE_KEY;
}
let credentialMutation = Promise.resolve();
let credentialGeneration = 0;

function enqueueCredentialMutation(operation: () => Promise<void>): Promise<void> {
  const next = credentialMutation.then(operation, operation);
  credentialMutation = next.catch(() => undefined);
  return next;
}

export async function isBiometricAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const result = await NativeBiometric.isAvailable();
    return result.isAvailable;
  } catch {
    return false;
  }
}

/** Return a user-facing label for the device's biometric type (e.g. "Face ID", "Touch ID"). */
export async function getBiometricLabel(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return 'Biometric';
  try {
    const result = await NativeBiometric.isAvailable();
    return biometryLabel(result.biometryType);
  } catch {
    return 'Biometric';
  }
}

export function biometryLabel(type: BiometryType): string {
  switch (type) {
    case BiometryType.FACE_ID:
      return 'Face ID';
    case BiometryType.TOUCH_ID:
      return 'Touch ID';
    case BiometryType.FINGERPRINT:
      return 'Fingerprint';
    case BiometryType.FACE_AUTHENTICATION:
      return 'Face Authentication';
    case BiometryType.IRIS_AUTHENTICATION:
      return 'Iris';
    default:
      return 'Biometric';
  }
}

/** Store JWT in Keychain after successful passphrase login. */
export async function saveCredentials(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await enqueueCredentialMutation(async () => {
    try {
      await NativeBiometric.setCredentials({
        username: 'mitzo-user',
        password: token,
        server: SERVER,
      });
    } catch {
      // Keychain write failed — fall back to localStorage only
    }
  });
}

/** Explicit opt-in only: iOS Keychain requires the enrolled biometrics at read time. */
export async function saveBiometricPassphrase(
  passphrase: string,
  apiBaseUrl = getApiBaseUrl(),
): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !passphrase) return false;
  let saved = false;
  await enqueueCredentialMutation(async () => {
    try {
      await NativeBiometric.setData({
        key: passphraseKey(apiBaseUrl),
        value: passphrase,
        accessControl: AccessControl.BIOMETRY_CURRENT_SET,
      });
      localStorage.removeItem(`${passphraseKey(apiBaseUrl)}.disabled`);
      saved = true;
    } catch {
      // Never fall back to unprotected storage for the passphrase.
    }
  });
  return saved;
}

/** Remove stored credentials (logout). */
export async function deleteCredentials(apiBaseUrl = getApiBaseUrl()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  credentialGeneration++;
  // An opted-in passphrase can create new sessions even after server logout.
  // Persist refusal before native deletion, which can fail while the device locks.
  const disabledKey = `${passphraseKey(apiBaseUrl)}.disabled`;
  localStorage.setItem(disabledKey, '1');
  await enqueueCredentialMutation(async () => {
    localStorage.setItem(disabledKey, '1');
    try {
      await NativeBiometric.deleteCredentials({ server: SERVER });
    } catch {
      // No legacy credentials to delete
    }
    try {
      await NativeBiometric.deleteData({ key: passphraseKey(apiBaseUrl) });
    } catch {
      // No protected credential to delete
    }
  });
}

/**
 * Unlock an explicitly enrolled passphrase through native Keychain biometrics and
 * obtain a fresh ordinary server session. Legacy saved JWTs remain usable until
 * expiry; one passphrase login with opt-in enrolls the durable unlock credential.
 */
let loginInFlight: { baseUrl: string; promise: Promise<string | null> } | undefined;

export function biometricLogin(apiBaseUrl = ''): Promise<string | null> {
  if (loginInFlight) {
    return loginInFlight.baseUrl === apiBaseUrl ? loginInFlight.promise : Promise.resolve(null);
  }
  const promise = performBiometricLogin(apiBaseUrl);
  loginInFlight = { baseUrl: apiBaseUrl, promise };
  void promise.finally(() => {
    if (loginInFlight?.promise === promise) loginInFlight = undefined;
  });
  return promise;
}

async function performBiometricLogin(apiBaseUrl: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (localStorage.getItem(`${passphraseKey(apiBaseUrl)}.disabled`) === '1') return null;
  if (isLogoutPending()) {
    await deleteCredentials(apiBaseUrl);
    return null;
  }
  const authTokenAtStart = getStoredAuthToken();
  const credentialGenerationAtStart = credentialGeneration;
  const credentialContextIsCurrent = () =>
    credentialGeneration === credentialGenerationAtStart &&
    localStorage.getItem(`${passphraseKey(apiBaseUrl)}.disabled`) !== '1';
  const authContextIsCurrent = () =>
    credentialContextIsCurrent() && !isLogoutPending() && getStoredAuthToken() === authTokenAtStart;

  try {
    let passphrase: string | undefined;
    try {
      const protectedData = await NativeBiometric.getSecureData({
        key: passphraseKey(apiBaseUrl),
        reason: 'Unlock Mitzo',
      });
      passphrase = protectedData.value;
      if (!passphrase) return null;
    } catch (error) {
      // Missing enrollment can use the old JWT. Cancellation, lockout and other
      // Keychain failures must not cause another native prompt.
      if (String((error as { code?: unknown })?.code) !== '21') return null;
    }
    if (!authContextIsCurrent()) return null;

    let token: string | undefined;
    if (!passphrase) {
      await NativeBiometric.verifyIdentity({
        reason: 'Unlock Mitzo',
        title: 'Mitzo',
        subtitle: 'Authenticate to continue',
        useFallback: true,
      });
      const credentials = await NativeBiometric.getCredentials({ server: SERVER });
      token = credentials.password;
      if (!token || !authContextIsCurrent()) return null;
    }

    // Authorization checks must not load every provider's session catalog.
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    let res: Response;
    try {
      res = await Promise.race([
        fetch(`${apiBaseUrl}/api/auth/${passphrase ? 'login' : 'check'}`, {
          ...(passphrase
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passphrase }),
              }
            : { headers: { Authorization: `Bearer ${token}` } }),
          // Native login consumes the bearer only. Omitting cookies prevents a
          // late response from replacing a newer browser authentication cookie.
          credentials: passphrase ? 'omit' : 'include',
          signal: controller.signal,
        }).then(async (response) => {
          if (passphrase && response.ok) {
            const data = (await response.json()) as { token?: unknown };
            token = typeof data.token === 'string' && data.token ? data.token : undefined;
          }
          return response;
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Authentication check timed out'));
            controller.abort();
          }, 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!authContextIsCurrent()) return null;
    if (!res.ok) {
      if (
        (res.status === 401 || res.status === 403) &&
        (passphrase
          ? authTokenAtStart === null
          : authTokenAtStart === null || authTokenAtStart === token)
      ) {
        markAuthLost();
        await deleteCredentials(apiBaseUrl);
      }
      return null;
    }

    if (!token) return null;

    loginSucceeded(token);
    // Optional Watch sync must not hold native login open. The queue rechecks
    // current authority before writing, so a newer login/logout can supersede it.
    const restoredToken = token;
    void saveTokenToWatch(
      restoredToken,
      () =>
        credentialContextIsCurrent() &&
        !isLogoutPending() &&
        getStoredAuthToken() === restoredToken,
    ).catch(() => undefined);
    return token;
  } catch {
    return null;
  }
}
