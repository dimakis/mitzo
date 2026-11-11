# Sign in with Apple while retaining Tailscale

This optional authentication method links one Apple account to Mitzo's existing
primary operator. Tailscale still controls network reachability. There is no
tunnel, public signup, new user role, or change to tool/connection approvals.
Passphrase login remains the recovery path. The feature is disabled unless its
server configuration is supplied; these source changes do not activate it.

## Setup and activation

Before activation, complete code review, CI and the browser/device checks below.
Production deployment and provisioning changes are separate operator actions.

1. In the Apple Developer account, enable **Sign in with Apple** on Mitzo's
   primary App ID. Confirm the actual iOS bundle identifier and team; the source
   currently uses `com.mitzo.app`. Create a web **Services ID**, associate it with
   that primary App ID, and configure the Mitzo HTTPS hostname and exact return
   URL `https://HOST/api/auth/apple/callback`. Web/native grouping matters:
   otherwise the same person can receive different Apple subject identifiers.
2. Keep the existing Tailscale connection. Use a browser-trusted HTTPS hostname
   that resolves to Mitzo from the user's device. Register that exact URL with
   Apple; IP addresses and localhost are not supported. A Tailscale HTTPS name
   is a candidate, subject to acceptance in the actual Apple Developer setup.
   Verify this on the selected installation before promising compatibility.
   Apple's browser redirect returns through the user's device; it does not
   require an inbound public tunnel. The server needs outbound access to
   `appleid.apple.com` for the code exchange and public signing keys.
3. Create a Sign in with Apple key associated with that primary App ID. Store the
   `.p8` file only in the controller's private `~/.mitzo/apple-sign-in/`
   directory, with directory mode `0700` and file mode `0600`. Keep it out of
   repositories, agents' workspaces, browser assets, logs and chat messages.
   Retain the runtime's existing denial of agent access to `~/.mitzo`.
4. Configure the server environment as documented in `.env.example`:

   | Variable                       | Value                                                                     |
   | ------------------------------ | ------------------------------------------------------------------------- |
   | `MITZO_APPLE_CLIENT_ID`        | Web Services ID                                                           |
   | `MITZO_APPLE_NATIVE_CLIENT_ID` | iOS App ID/bundle identifier; optional until native provisioning is ready |
   | `MITZO_APPLE_TEAM_ID`          | Ten-character Apple developer team identifier                             |
   | `MITZO_APPLE_KEY_ID`           | Ten-character Apple signing-key identifier                                |
   | `MITZO_APPLE_PRIVATE_KEY_PATH` | Absolute path to the private `.p8` file                                   |
   | `MITZO_APPLE_REDIRECT_URI`     | Exact registered HTTPS callback URL                                       |

   No secret goes in `VITE_*` variables. Partial configuration prevents startup
   instead of silently enabling an incomplete authentication method. With no
   Apple configuration, the normal passphrase deployment is unchanged. For the
   native app, retain the existing allowed CORS origin `capacitor://localhost`.

5. Recreate the iOS provisioning profile with the Sign in with Apple capability
   and build/sign the application. The App target now declares the entitlement
   and registers `AppleSignInBridge`; an older installed app cannot use this
   method. Native login uses AuthenticationServices, not an embedded Apple web
   login. Configuring web login alone does not provision the native app.
6. At Mitzo's login page, enter the existing operator passphrase, choose
   **Connect Apple account**, and authenticate with the intended Apple account.
   The passphrase authorizes this one enrollment attempt. It is not sent to
   Apple. Once connected, the page offers **Sign in with Apple**. A different
   Apple account is refused rather than silently replacing the owner.

## Authentication and storage

- Web: authorization-code flow, no profile/email scopes, `response_mode=query`.
  A random state and nonce are bound to a separate Secure, HttpOnly, SameSite=Lax
  `__Host-mitzo-apple` cookie. After server verification, the existing `cc_auth`
  session cookie is set Secure/HttpOnly/SameSite=Strict. The application bearer
  never appears in the redirect URL or response body. The login page verifies
  the cookie using `/api/auth/check` before restoring local authentication.
- iOS: the server creates state, nonce and a verifier. AuthenticationServices
  returns a one-use authorization code and matching state. The client sends
  the code and verifier to the server; the server validates the native audience.
  The resulting ordinary Mitzo token follows the existing native session path.
  A cancelled, superseded or unmounted client cannot apply a late result.
- The provider adapter exchanges codes only at Apple's fixed token endpoint,
  with a five-minute ES256 client secret. It validates Apple's RS256 signature,
  issuer, exact audience, nonce, subject, issued-at and expiry. Upstream response
  size and request duration are bounded. HTTP inputs are bounded and strict;
  authentication POSTs require JSON and a configured Origin, with rate limits.
- Pending attempts last five minutes, are consumed before an asynchronous code
  exchange, and are bounded to 128 entries. Restarting the server invalidates
  outstanding attempts. Retry from the login page after a restart or timeout.
  Simultaneous browser attempts in one browser profile can supersede the binding
  cookie; retry the unsuccessful attempt. A completed web flow returns to the
  normal home destination; native flows preserve the existing return path.
- The verified opaque Apple subject is stored in the controller's private
  `~/.mitzo/apple-sign-in/owner.json`, using exclusive creation and mode `0600`.
  It contains no name, email, password, identity token or refresh token. Corrupt,
  unreadable, permissively readable or symlinked owner files fail closed.
  Enrollment never overwrites an existing owner, including concurrent attempts.
- No email is used for authorization. Apple's Hide My Email choice therefore
  does not affect account matching. Existing session expiration, persistent
  logout revocation, transport ownership and action approvals still apply.
  Existing device passphrase/biometric enrollment remains explicit. Where Apple
  login is enabled, sign-in selection is explicit to prevent automatic biometric
  login racing an Apple request. Watch synchronization remains owned by the
  existing verified-session route.

## Recovery and limits

Use the passphrase if Apple is unavailable. Do not delete an unreadable owner
file as an automatic repair: that would reopen enrollment. Inspect and restore
the retained private record through the operator's normal host administration.
If an account must be replaced, make a separate explicit recovery decision,
preserve the old record, stop the configured service, and re-enroll after
restarting. No remote unlink or account-transfer operation is exposed here.

Removing Apple configuration and restarting disables new Apple logins. It does
not revoke sessions already issued; those remain subject to ordinary Mitzo
logout and `COOKIE_MAX_AGE_HOURS` (24 hours by default). Changing or removing the
owner file also does not revoke previously issued sessions. If sessions may be
compromised, use the deployment's established session invalidation procedure.
Do not claim an Apple unlink or key rotation alone logs out every Mitzo device.

This first method does not retain Apple refresh tokens, periodically revalidate
Apple consent, or consume Apple's server-to-server account-change notifications.
Apple-side account revocation therefore does not immediately revoke an existing
Mitzo session. Account transfer, multi-user authorization, refresh-based sessions
and public access remain separate work. Do not expose Mitzo publicly on the
strength of this feature alone.

The existing Watch bridge has optional storage fallbacks that can hide a failed
Keychain save from the login UI. This feature reuses the existing protected-route
integration; a device test must confirm Watch behavior. Repairing shared Watch
failure presentation is follow-up work, not proof supplied by Apple login tests.

## Verification and remaining activation checks

Offline tests use synthetic signing keys and responses; none call Apple or a
model. Focused coverage includes owner enrollment/proof, wrong account, signature,
issuer, audience, nonce, expiry, callback injection/replay, cookie flags, native
state binding, parser failure redaction, existing session revocation, native
cancellation, missing plugin, status retry, passphrase recovery and late logout.
The real Login page and client adapter are covered together in component tests.

As of 11 November 2026:

- 109 focused authentication and login tests passed; 109 shared design tests
  passed with one pre-existing skipped design fixture.
- The new server authentication modules (including runtime wiring), Login page,
  client adapter and client tests passed targeted strict TypeScript checks.
- Swift syntax and Xcode project/entitlement plist checks passed. This is not a
  full iOS SDK build or a signed-device test.
- Full server and frontend TypeScript builds exceeded the mandated 1 GiB local
  heap limit. Full builds remain required in CI.
- Offline Playwright cases are supplied for phone/desktop, light/dark,
  alternate font/accent, keyboard/touch access, recovery, cancellation and late
  completion. Browser startup was blocked by macOS process-registration
  permissions through the task runner; no screenshot or browser success is
  claimed. Run `npm run test:ui` in the supported CI/host environment and inspect
  the login screenshots before activation.

The UI reuses the existing login form, shared primary/secondary controls, focus
styles, spacing, control height and muted/type tokens. No new container or
motion system is introduced. The local `frontend/public/apple-sign-in.png` is
Apple's official 240 × 44 sign-in button image, retrieved from
`https://appleid.cdn-apple.com/appleid/button?color=black&border=true&type=sign-in&height=44&width=240&locale=en_US`.
It requires no third-party asset request from the login page.

Before enabling a real installation, verify Apple's acceptance of the return
URL, trusted TLS over Tailscale, web and native subject grouping, enrollment with
the intended owner, rejection of a second account, cancel/retry, iPhone sheet
presentation, expired/replayed callbacks, logout/reconnect, passphrase recovery
and the signed App/Watch build. No production environment, Apple Developer
account or Tailscale configuration was changed by this implementation.

## Provider references

Apple documentation consulted 11 November 2026:

- [Authorize](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.)
- [Generate and validate tokens](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Verify a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
- [Configure the web service](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)
- [Account-change notifications](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts)
