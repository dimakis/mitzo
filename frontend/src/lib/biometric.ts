import { Capacitor } from '@capacitor/core';
import { NativeBiometric, BiometryType } from '@capgo/capacitor-native-biometric';
import { saveTokenToWatch } from './watch-auth';
import { getStoredAuthToken, isLogoutPending, loginSucceeded, markAuthLost } from './api-fetch';

const SERVER = 'com.mitzo.app';
let credentialMutation = Promise.resolve();

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

/** Remove stored credentials (logout). */
export async function deleteCredentials(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await enqueueCredentialMutation(async () => {
    try {
      await NativeBiometric.deleteCredentials({ server: SERVER });
    } catch {
      // No credentials to delete
    }
  });
}

/**
 * Attempt biometric login: prompt Face ID / Touch ID, retrieve JWT from Keychain,
 * validate with server, store in localStorage for apiFetch, and return the token.
 * Returns null if biometric auth fails, no credentials stored, or token is expired.
 */
export async function biometricLogin(apiBaseUrl = ''): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  if (isLogoutPending()) {
    await deleteCredentials();
    return null;
  }
  const authTokenAtStart = getStoredAuthToken();
  const authContextIsCurrent = () =>
    !isLogoutPending() && getStoredAuthToken() === authTokenAtStart;

  try {
    await NativeBiometric.verifyIdentity({
      reason: 'Unlock Mitzo',
      title: 'Mitzo',
      subtitle: 'Authenticate to continue',
      useFallback: true,
    });

    const credentials = await NativeBiometric.getCredentials({
      server: SERVER,
    });
    const token = credentials.password;

    if (!token) return null;
    if (!authContextIsCurrent()) return null;

    // Authorization checks must not load every provider's session catalog.
    const controller = new AbortController();
    let timeout!: ReturnType<typeof setTimeout>;
    let res: Response;
    try {
      res = await Promise.race([
        fetch(`${apiBaseUrl}/api/auth/check`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'include',
          signal: controller.signal,
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
        (authTokenAtStart === null || authTokenAtStart === token)
      ) {
        markAuthLost();
        await deleteCredentials();
      }
      return null;
    }

    // Also save to native shared Keychain for Apple Watch
    await saveTokenToWatch(token);
    if (!authContextIsCurrent()) return null;
    loginSucceeded(token);
    return token;
  } catch {
    return null;
  }
}
