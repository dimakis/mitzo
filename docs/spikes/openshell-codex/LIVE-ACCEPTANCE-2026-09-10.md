# OpenShell live acceptance plan

Status: in progress on isolated branch `codex/openshell-live-acceptance` at
`deeb5371dfd9aeb3b391861ab52d8ad43f62619e`. Production remains unchanged at
`f8479f20542ffaa1b4b90ef12d0e6dce55ff7b35`.

Personal-subscription acceptance completed on the isolated
`codex/openshell-personal-subscription` branch on 2026-09-10. This does not
promote an image, deploy a controller, or satisfy the unrelated service-provider
and retained-recovery gates below.

## Safety envelope

- Use a disposable repository root and set both
  `MITZO_DISABLE_REPO_MAINTENANCE=1` and `MITZO_REPO_PATH_CEILING` before any
  development server starts.
- Never use port 3100, the production checkout, a retained sandbox, or a mutable
  image tag for acceptance.
- Never mount or copy host credential directories. Credentials remain in
  gateway providers. Do not print tokens, provider payloads, request headers,
  process environments, or model-visible Google data.
- Personal ChatGPT remains fail-closed until its OAuth implementation is rebased
  and reviewed against one matched CLI, gateway, supervisor, base image, and
  derived image set. A work API turn is not a substitute.
- Live service checks are individually bounded and require an explicit policy;
  each positive check is paired with a denial control.

## Gates

1. **Merged baseline** — install the lockfile dependencies and pass the full test
   suite on `deeb5371`.
2. **Component bill of materials** — record exact CLI/gateway/driver versions,
   supervisor digest, base-image digest, derived-image digest, Codex version,
   and GWS version. Reject mutable or mismatched inputs.
3. **Fresh runtime fixture** — prepare a filtered MGMT seed, verify its manifest
   and portable Git baseline, build a uniquely tagged image, and create only
   fresh conversation-labeled sandboxes.
4. **Isolated controller** — start current-main Mitzo on a non-production port
   with a disposable `REPO_PATH`, a canonical path ceiling, maintenance disabled,
   an absolute account file, the pinned image/policy/seed, reviewed provider
   names, and web search disabled by default.
5. **Normal work-API workflow** — through the public SSE route, prove automatic
   sandbox provisioning, exact MGMT boot context, a real model turn, visible
   shell/tool streaming, local edit/diff/commit, cancellation, and absence of
   host metadata or credential leakage.
6. **Retained recovery** — stop and start the same fresh sandbox while the
   controller stays running; acknowledge recovery and resume the exact persisted
   conversation/thread with the same workspace state.
7. **Google Workspace** — after provider-name alignment and a reviewed
   gateway-owned refresh path, run only `Drive files.list` with `pageSize=1` and
   `fields=files(id)`. Report only pass/fail and returned count; expose no ID,
   name, content, or credential material. Verify an out-of-policy request is
   denied.
8. **GitHub** — through the reviewed `github` provider, prove an authenticated
   metadata read and private clone into the sandbox, then prove a network or
   remote-write denial. Local Git edit and commit must remain functional.
9. **Personal ChatGPT** — rebase/port the preserved OAuth proof onto the matched
   OpenShell release, review refresh persistence and provider isolation, then run
   one real subscription-backed model/tool turn. Do not start a new login unless
   the retained refresh path is verified to have failed and attended authorization
   is explicitly requested.
10. **Optional capabilities** — separately prove one sandbox-executed MCP call
    and one native live web search, each with fail-closed configuration and denial
    controls.
11. **Rollout readiness** — add production configuration validation, readiness
    and provider audit signals, immutable image promotion, a conversation
    migration procedure, and a rollback procedure. Request production deployment
    authorization only after all non-deferred gates pass.

## Deferred

Kubernetes/Kata, other agent harnesses, sandbox destroy/recreate checkpoints,
cross-node durability, and reviewed save-back are outside this acceptance pass.

## Personal-subscription acceptance record

- Mitzo source under test included `4519e9b` plus the runtime transport changes
  on `codex/openshell-personal-subscription`.
- The reviewed OAuth fork was `2098a95c`, with safe provider-status output at
  `2f5853f3` and the direct-endpoint SSH compatibility patch under review.
- The isolated gateway listened on loopback port 18670 and used a fresh state
  root. The default gateway and production controller were not changed.
- The pinned supervisor image was
  `localhost/openshell/supervisor:mitzo-oauth-2098a95c`; the uniquely tagged
  runtime image was
  `localhost/mitzo-mgmt-runtime:subscription-4519e9b-r2-20260910` with Codex
  0.153.4.
- A credential-free direct inference control returned the expected marker
  through `https://inference.local/v1`; a direct request to `api.openai.com`
  without gateway injection was rejected.
- The public Mitzo SSE workflow selected account
  `openshell-personal-subscription` and model `gpt-5.6-sol`, provisioned a fresh
  conversation-labelled sandbox, emitted sandbox boot context, completed a real
  subscription-backed turn, and ended normally.
- A separate read-only command inside that sandbox confirmed the requested file
  contained exactly `MITZO_NORMAL_SSE=pass`. No host API credential or OAuth
  token was mounted, copied, logged, or passed to the Codex process.

## Evidence rules

Synthetic tests, direct transport probes, host authentication checks, and real
normal Mitzo workflow checks are reported separately. A lower-level success does
not satisfy a higher-level gate. Every live record includes the source commit,
component versions/digests, fresh sandbox identity/labels, policy revision,
controller port, bounded operation, denial control, and sanitized outcome.
