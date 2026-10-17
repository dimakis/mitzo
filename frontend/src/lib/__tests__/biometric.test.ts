// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock('@capgo/capacitor-native-biometric', () => ({
  NativeBiometric: {
    isAvailable: vi.fn(),
    setData: vi.fn(),
    getSecureData: vi.fn(),
    deleteData: vi.fn(),
    verifyIdentity: vi.fn(),
    getCredentials: vi.fn(),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
  },
  AccessControl: { BIOMETRY_CURRENT_SET: 1 },
  BiometryType: {
    NONE: 0,
    TOUCH_ID: 1,
    FACE_ID: 2,
    FINGERPRINT: 3,
    FACE_AUTHENTICATION: 4,
    IRIS_AUTHENTICATION: 5,
    MULTIPLE: 6,
    DEVICE_CREDENTIAL: 7,
  },
}));

vi.mock('../watch-auth', () => ({ saveTokenToWatch: vi.fn().mockResolvedValue(undefined) }));

import { Capacitor } from '@capacitor/core';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import {
  isBiometricAvailable,
  biometricLogin,
  saveCredentials,
  saveBiometricPassphrase,
  deleteCredentials,
} from '../biometric';

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(NativeBiometric.getSecureData).mockRejectedValue({ code: '21' });
});

describe('isBiometricAvailable', () => {
  it('returns false in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await isBiometricAvailable()).toBe(false);
  });

  it('returns true when native biometric is available', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.isAvailable).mockResolvedValue({
      isAvailable: true,
      biometryType: 2,
      errorCode: 0,
      strongBiometryIsAvailable: true,
      deviceIsSecure: true,
      authenticationStrength: 'strong',
    } as never);
    expect(await isBiometricAvailable()).toBe(true);
  });

  it('returns false when plugin throws', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.isAvailable).mockRejectedValue(new Error('fail'));
    expect(await isBiometricAvailable()).toBe(false);
  });
});

describe('saveBiometricPassphrase', () => {
  it('stores the opted-in passphrase behind the current biometric enrollment', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(await saveBiometricPassphrase('my-passphrase')).toBe(true);
    expect(NativeBiometric.setData).toHaveBeenCalledWith({
      key: 'com.mitzo.app.biometric-passphrase',
      value: 'my-passphrase',
      accessControl: 1,
    });
    expect(localStorage.getItem('my-passphrase')).toBeNull();
  });
  it('keeps remembered passphrases scoped to the selected server', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await saveBiometricPassphrase('secret', 'https://selected.test');
    expect(NativeBiometric.setData).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'com.mitzo.app.biometric-passphrase:https%3A%2F%2Fselected.test',
      }),
    );
  });

  it('reports enrollment failure instead of pretending it succeeded', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.setData).mockRejectedValueOnce(new Error('Keychain failed'));
    expect(await saveBiometricPassphrase('my-passphrase')).toBe(false);
  });
});

describe('saveCredentials', () => {
  it('no-ops in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await saveCredentials('test-token');
    expect(NativeBiometric.setCredentials).not.toHaveBeenCalled();
  });

  it('stores token in keychain on native', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await saveCredentials('jwt-123');
    expect(NativeBiometric.setCredentials).toHaveBeenCalledWith({
      username: 'mitzo-user',
      password: 'jwt-123',
      server: 'com.mitzo.app',
    });
  });
});

describe('deleteCredentials', () => {
  it('no-ops in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    await deleteCredentials();
    expect(NativeBiometric.deleteCredentials).not.toHaveBeenCalled();
  });

  it('removes the protected passphrase on logout even if legacy deletion fails', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.deleteCredentials).mockRejectedValueOnce(new Error('no legacy JWT'));
    await deleteCredentials();
    expect(NativeBiometric.deleteData).toHaveBeenCalledWith({
      key: 'com.mitzo.app.biometric-passphrase',
    });
  });

  it('serializes a newer save behind an in-flight credential deletion', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let finishDelete!: () => void;
    vi.mocked(NativeBiometric.deleteCredentials).mockReturnValue(
      new Promise<void>((resolve) => {
        finishDelete = resolve;
      }) as never,
    );

    const deleting = deleteCredentials();
    await vi.waitFor(() => expect(NativeBiometric.deleteCredentials).toHaveBeenCalled());
    const saving = saveCredentials('new-token');
    await Promise.resolve();
    expect(NativeBiometric.setCredentials).not.toHaveBeenCalled();

    finishDelete();
    await Promise.all([deleting, saving]);
    expect(NativeBiometric.setCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'new-token' }),
    );
  });
});

describe('biometricLogin', () => {
  it('obtains a fresh ordinary session from the protected passphrase after JWT expiry', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    localStorage.setItem('mitzo_auth_token', 'expired-jwt');
    vi.mocked(NativeBiometric.getSecureData).mockResolvedValue({ value: 'my-passphrase' });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'fresh-jwt' }),
    } as Response);
    expect(await biometricLogin('https://mitzo.test')).toBe('fresh-jwt');
    expect(NativeBiometric.verifyIdentity).not.toHaveBeenCalled();
    expect(NativeBiometric.getCredentials).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://mitzo.test/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ passphrase: 'my-passphrase' }),
      }),
    );
    expect(localStorage.getItem('mitzo_auth_token')).toBe('fresh-jwt');
  });

  it('preserves the protected credential when the login server is temporarily unavailable', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.getSecureData).mockResolvedValue({ value: 'secret' });
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(await biometricLogin()).toBeNull();
    expect(NativeBiometric.deleteData).not.toHaveBeenCalled();
  });

  it('does not send the protected passphrase if logout occurs during the native prompt', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let finishUnlock!: (value: { value: string }) => void;
    vi.mocked(NativeBiometric.getSecureData).mockReturnValue(
      new Promise((resolve) => {
        finishUnlock = resolve;
      }),
    );
    const fetchMock = vi.spyOn(global, 'fetch');
    const pending = biometricLogin();
    localStorage.setItem('mitzo_logout_pending', '1');
    finishUnlock({ value: 'secret' });
    expect(await pending).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fall back to a second prompt after protected Keychain cancellation', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.getSecureData).mockRejectedValue({ code: '16' });
    expect(await biometricLogin()).toBeNull();
    expect(NativeBiometric.verifyIdentity).not.toHaveBeenCalled();
  });

  it('shares one native identity prompt between overlapping unlock attempts', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    let finishIdentity!: () => void;
    vi.mocked(NativeBiometric.verifyIdentity).mockReturnValue(
      new Promise<void>((resolve) => {
        finishIdentity = resolve;
      }) as never,
    );
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    const automatic = biometricLogin();
    const manual = biometricLogin();
    await vi.waitFor(() => expect(NativeBiometric.verifyIdentity).toHaveBeenCalledOnce());
    finishIdentity();
    expect(await Promise.all([automatic, manual])).toEqual(['stored-jwt', 'stored-jwt']);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('refuses retained native credentials while logout is pending', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    localStorage.setItem('mitzo_logout_pending', '1');

    expect(await biometricLogin()).toBeNull();
    expect(NativeBiometric.verifyIdentity).not.toHaveBeenCalled();
    expect(NativeBiometric.deleteCredentials).toHaveBeenCalled();
  });

  it('returns null in browser', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    expect(await biometricLogin()).toBeNull();
  });

  it('returns token after successful biometric verification', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });

    // Mock fetch for server validation (vi.spyOn auto-restores on clearAllMocks)
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

    const token = await biometricLogin();
    expect(token).toBe('stored-jwt');
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/check',
      expect.objectContaining({ headers: { Authorization: 'Bearer stored-jwt' } }),
    );
    expect(localStorage.getItem('mitzo_auth_token')).toBe('stored-jwt');
  });

  it('does not overwrite a newer login when biometric validation succeeds late', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });
    let resolveValidation!: (response: Response) => void;
    vi.spyOn(global, 'fetch').mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveValidation = resolve;
      }),
    );

    const pending = biometricLogin();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    localStorage.setItem('mitzo_auth_token', 'fresh-login');
    resolveValidation({ ok: true } as Response);

    expect(await pending).toBeNull();
    expect(localStorage.getItem('mitzo_auth_token')).toBe('fresh-login');
  });

  it('does not clear newer credentials when biometric validation fails late', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });
    let resolveValidation!: (response: Response) => void;
    vi.spyOn(global, 'fetch').mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveValidation = resolve;
      }),
    );

    const pending = biometricLogin();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    localStorage.setItem('mitzo_auth_token', 'fresh-login');
    resolveValidation({ ok: false, status: 401 } as Response);

    expect(await pending).toBeNull();
    expect(localStorage.getItem('mitzo_auth_token')).toBe('fresh-login');
    expect(NativeBiometric.deleteCredentials).not.toHaveBeenCalled();
  });

  it('preserves a valid local login when a different Keychain token is rejected', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stale-keychain-token',
    });
    localStorage.setItem('mitzo_auth_token', 'valid-local-token');
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    expect(await biometricLogin()).toBeNull();
    expect(localStorage.getItem('mitzo_auth_token')).toBe('valid-local-token');
  });

  it('deletes a rejected Keychain token when no different local login exists', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stale-keychain-token',
    });
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);

    expect(await biometricLogin()).toBeNull();
    expect(NativeBiometric.deleteCredentials).toHaveBeenCalledOnce();
  });

  it.each([500, 503])(
    'retains credentials after a temporary server failure (%s)',
    async (status) => {
      vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
      vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
      vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
        username: 'mitzo-user',
        password: 'stored-jwt',
      });
      localStorage.setItem('mitzo_auth_token', 'stored-jwt');
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }));
      expect(await biometricLogin()).toBeNull();
      expect(localStorage.getItem('mitzo_auth_token')).toBe('stored-jwt');
      expect(NativeBiometric.deleteCredentials).not.toHaveBeenCalled();
    },
  );

  it('bounds an unreachable validation request and retains credentials', async () => {
    vi.useFakeTimers();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockResolvedValue(undefined as never);
    vi.mocked(NativeBiometric.getCredentials).mockResolvedValue({
      username: 'mitzo-user',
      password: 'stored-jwt',
    });
    localStorage.setItem('mitzo_auth_token', 'stored-jwt');
    vi.spyOn(global, 'fetch').mockReturnValue(new Promise(() => {}));
    const validation = biometricLogin();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await validation).toBeNull();
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(localStorage.getItem('mitzo_auth_token')).toBe('stored-jwt');
    expect(NativeBiometric.deleteCredentials).not.toHaveBeenCalled();
  });

  it('returns null when verification fails', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(NativeBiometric.verifyIdentity).mockRejectedValue(new Error('cancelled'));

    expect(await biometricLogin()).toBeNull();
  });
});
