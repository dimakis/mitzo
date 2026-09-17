# Provider and Capability Platform

Status: proposed implementation design
Primary implementation model: Terra
Suitable Luna work: isolated UI components, schema fixtures, documentation, and bounded unit tests

## Problem

Mitzo can already attach OpenShell providers to retained conversation sandboxes, but its two configuration surfaces are inconsistent:

- OpenShell provider profiles are generic security policies covering credentials, refresh, egress endpoints, protocol inspection, and permitted binaries.
- Mitzo's managed Connections store, API, service, probes, and UI are hard-coded to one `jira-readonly` template.

The inconsistency is visible in GitHub handling. Mitzo automatically attaches OpenShell's built-in `github` provider and tells closing agents to push branches and create pull requests. That profile intentionally permits only GitHub reads and `git-upload-pack`; GitHub API mutations and `git-receive-pack` are denied. The agent can produce a correct local commit but cannot publish it.

Simply making the GitHub provider read-write is not acceptable. Network policy can allow `git-receive-pack`, but cannot express semantic constraints such as “feature branches only,” “never force-push,” “only these repositories,” or “create a PR after the push.”

## Decision

Generalise Mitzo around two distinct concepts:

1. **Connections** grant credentials plus bounded sandbox egress.
2. **Capabilities** perform reviewed mutations through typed controller-side executors.

Connections answer “what may this sandbox reach and read?” Capabilities answer “what consequential action may Mitzo perform after approval?” A provider may expose sandbox-native read operations, controller-mediated write capabilities, or both.

This is an explicit trust boundary. Provider profiles remain network and credential policy. Capability executors enforce application semantics that cannot be expressed safely at the network layer.

## Security invariants

The implementation is incomplete unless all of these hold:

1. Raw credentials remain gateway-owned and never enter Mitzo responses, logs, Telos, prompts, or sandbox files.
2. A retained sandbox never gains a new connection or capability silently. Assignment changes apply to new conversations; explicit in-chat grants remain approval-gated.
3. Provider profiles and capability definitions are versioned, immutable templates. Updating a template creates a new version; existing connections retain their recorded version until migrated.
4. Normal users select reviewed templates. Raw policy YAML and arbitrary binaries are unavailable outside Operator mode.
5. Custom endpoint hosts are canonicalised and reject IP literals, localhost, link-local, private ranges, wildcard public suffixes, embedded credentials, redirects to unapproved hosts, and non-TLS defaults.
6. Effective access is fail-closed. Unknown profile fields, protocol modes, credential styles, rules, or binaries are rejected rather than passed through.
7. Write capabilities use structured inputs, a named executor, a forced approval card, idempotency keys, bounded output, durable audit records, and postcondition verification.
8. Network-level write access is allowed only when the reviewed policy can express the full safety boundary. Otherwise the operation must use a controller capability.
9. Capability executors do not execute repository code, hooks, or arbitrary user commands on the host.
10. Removing or reducing access stops affected retained sandboxes before detaching credentials. Existing connection quarantine and reconciliation behavior remains authoritative.

## Domain model

### ProviderTemplate

A reviewed, versioned definition of sandbox connectivity.

```ts
interface ProviderTemplate {
  id: string;
  version: number;
  label: string;
  category: 'source-control' | 'productivity' | 'data' | 'custom-api';
  description: string;
  risk: 'read-only' | 'bounded-write' | 'operator-defined';
  credentialFields: CredentialField[];
  connectionFields: ConnectionField[];
  policyCompiler: string;
  probe: string;
  capabilityIds: string[];
}
```

The browser receives only display metadata and field descriptions. It never receives stored credential values or the complete gateway credential configuration.

### Connection

A provisioned instance of a template, owned by the operator and assigned to zero or more eligible Mitzo account profiles. Extend the current connection record with template-neutral identity and configuration metadata:

```ts
interface Connection {
  templateId: string;
  templateVersion: number;
  label: string;
  endpoint: string;
  publicConfig: Record<string, string | string[]>;
  gatewayProviderName: string;
  gatewayProviderId: string | null;
  desiredAccountIds: string[];
  identity: string | null;
  status: ConnectionStatus;
  revision: number;
}
```

Secrets remain one-shot request fields passed directly to the gateway adapter. They are not persisted in `connections.db`.

### CapabilityTemplate

A reviewed controller-side mutation contract.

```ts
interface CapabilityTemplate {
  id: string;
  version: number;
  label: string;
  description: string;
  connectionTemplateIds: string[];
  inputSchema: JsonSchema;
  executor: string;
  approval: 'always' | 'explicit-intent';
  idempotency: 'required';
}
```

The template registry maps symbolic compiler, probe, and executor names to code-owned implementations through null-prototype, own-property lookup. Configuration cannot name filesystem paths or shell commands. Provider and capability declarations must reference each other bidirectionally.

`jira-readonly@1` records its validated Jira email as an immutable public field. `github-readonly@1` records non-empty, canonical allowlists of exact `owner/repository` pairs and base branches; `github.publish-pr@1` must use those recorded allowlists when it is implemented. These fields constrain later work but do not enable writes in a sandbox.

Every custom REST policy carries a `pinned-public-only` DNS requirement. The gateway adapter must resolve and pin only public IP answers before provisioning, repeat resolution before every use, and fail closed if any answer is private, link-local, local/internal, invalid, or differs from the pin. This contract is mandatory even though the adapter wiring lands in Phase 1/5. Custom REST paths are exact canonical absolute paths (including `/`), optionally ending in one terminal `/**`; no other glob syntax is accepted.

IPv6 publicness is also fail-closed: the compiler accepts only a reviewed static allowlist of allocations from IANA's [IPv6 Global Unicast Address Space](https://www.iana.org/assignments/ipv6-unicast-address-assignments/), not all of `2000::/3`. The list is reviewed against that registry whenever the policy changes or ships; a newly allocated prefix remains unavailable until it is explicitly added with boundary tests. This prevents a stale classifier from silently treating IANA-reserved future space as public.

### CapabilityGrant and CapabilityOperation

`CapabilityGrant` records which capability versions a connection exposes and which account profiles may request them. `CapabilityOperation` is the durable audit/idempotency record for an invocation, including connection revision, conversation, requesting turn, approved input hash, status, external result identifier, and redacted failure code.

## Template registry

Add a code-owned registry under `server/connections/`:

```text
server/connections/
  templates.ts
  types.ts
  registry.ts
  policy-compiler.ts
  probes/
    jira-readonly.ts
    github-readonly.ts
  capabilities/
    registry.ts
    github-publish-pr.ts
```

Initial reviewed templates:

- `jira-readonly@1`: migrate existing behavior without semantic changes.
- `github-readonly@1`: wrap the built-in GitHub read profile and repository scope metadata.
- `custom-rest-readonly@1`: Operator-only HTTPS REST template with bounded, deduplicated methods and canonical paths, a capped rule expansion, credentials, binaries, and a public-only pinned-DNS requirement.

Initial capability:

- `github.publish-pr@1`: publish committed sandbox work to a non-default branch and create or update a pull request.

Do not implement arbitrary provider YAML import in the first release. The advanced builder compiles a deliberately smaller schema into OpenShell policy.

## GitHub publish capability

### User-visible contract

Inputs:

- connection ID
- sandbox repository path
- base branch
- title and body
- draft flag

Connection public configuration restricts allowed owners/repositories and base branches. Every invocation displays a forced approval card containing repository, source branch, base branch, commit count, changed-file summary, and whether an existing PR will be updated.

### Execution

1. Resolve the active conversation sandbox from trusted lifecycle state. Never accept a sandbox name from tool input.
2. Resolve the repository path beneath the conversation workspace using POSIX path canonicalisation. Reject escape attempts and symlink ambiguity.
3. Over the OpenShell control transport, require a clean Git working tree, a named non-default branch, a recognised GitHub origin, and at least one commit relative to `origin/<base>`.
4. Confirm the owner/repository and base branch are allowed by the selected connection.
5. Export committed changes as a bounded binary-safe patch series or a verified incremental bundle. Do not send GitHub write credentials into the sandbox.
6. On the host, create a mode-0700 temporary directory and a clean checkout of the trusted reconstructed GitHub URL. Disable hooks and repository-local configuration execution.
7. Apply the exported commits without running repository code. Reject conflicts; do not synthesize a partial branch.
8. Push only `HEAD:refs/heads/<approved-source-branch>`, without force options. Reject the default branch and protected patterns before network access.
9. If an open PR already exists for the branch, return it. Otherwise create the PR with the approved title/body/base/draft state.
10. Verify the returned repository, branch, base, and PR URL through a read-after-write query.
11. Persist the operation result before reporting success. Clean all temporary material in `finally`.

The executor must be dependency-injected for unit tests. Tests must prove that dirty trees, detached HEADs, default branches, non-GitHub remotes, disallowed repositories, disallowed bases, patch overflow, apply conflicts, non-fast-forward pushes, malformed PR URLs, cancellation, and duplicate retries fail safely.

## UX

### Connections catalog

Replace the Jira-only form with cards returned by `GET /api/connections/templates`:

- GitHub
- Jira
- Custom REST API (Operator mode)

Each card shows provider category, authentication method, data access, available capabilities, and risk label.

### Connection wizard

1. **Service** — choose a reviewed template.
2. **Authenticate** — render template-defined credential and connection fields. Secret fields are one-shot and cleared immediately after submission.
3. **Scope** — choose organisations, repositories, sites, base branches, or API path restrictions supported by the template.
4. **Capabilities** — enable reviewed mutation packs independently from sandbox egress.
5. **Assignments** — choose eligible Personal/Work account profiles and automatic versus on-demand attachment.
6. **Review** — show a plain-language effective-access summary plus an expandable technical policy preview.
7. **Verify** — provision a candidate provider, run its typed identity/scope probe, destroy the probe sandbox, then activate.

### Connection detail

Show:

- verified external identity
- template and version
- effective endpoint/method/path/binary access
- enabled capabilities
- assigned Mitzo profiles
- retained sandbox impact
- last verification and credential expiry
- audit history
- Test, Rotate, Change assignments, Revoke, and Remove controls

Policy expansion or capability addition requires recent reauthorization. Policy reduction retains the existing stop-detach-verify behavior.

### Advanced custom provider builder

Operator mode exposes only the supported policy subset:

- HTTPS domains and port
- REST or GraphQL inspection
- GET/HEAD/OPTIONS by default; explicit reviewed method/path rules
- credential style and header/query mapping
- allowlisted binaries selected from an administrator catalog
- automatic or on-demand attachment

The final review screen shows generated effective rules and warnings. Raw YAML remains export-only initially. A future import feature requires signed/reviewed policy bundles and is not part of this workstream.

## API surface

```text
GET    /api/connections/templates
POST   /api/connections
GET    /api/connections/:id
POST   /api/connections/:id/test
POST   /api/connections/:id/rotate
PUT    /api/connections/:id/assignments
PUT    /api/connections/:id/capabilities
POST   /api/connections/:id/revoke
DELETE /api/connections/:id

POST   /api/capability-operations
GET    /api/capability-operations/:id
```

Creation uses `{ templateId, templateVersion, label, fields, credentials, accountIds, capabilityIds, csrf }`. The server resolves the exact template version and validates fields against the code-owned schema. Clients cannot submit gateway profile IDs, provider names, binaries, or raw policy.

Capability execution from Codex uses the same service directly rather than loopback HTTP. Browser and agent paths share validation, authorization, idempotency, execution, and audit code.

## Migration

1. Add nullable/general fields without changing current Jira behavior.
2. Register `jira-readonly@1` and backfill existing rows transactionally.
3. Route existing Jira creation, rotation, probing, assignment, quarantine, and deletion through the registry adapters.
4. Switch the Connections UI to template metadata while preserving existing Jira copy and tests.
5. Only then add GitHub and custom templates.

No existing connection is silently widened. Existing legacy OpenShell providers remain operator-managed until explicitly adopted.

## Delivery phases

### Phase 0 — Contract and executable test fixtures

Files: `server/connections/types.ts`, `server/connections/registry.ts`, `server/__tests__/connection-template-registry.test.ts`, this document.

Deliver the type model, registry invariants, redaction rules, example manifests, and compile-time/runtime validation. No production route changes.

Gate: unknown fields and unsafe templates fail closed; fixtures cover Jira, GitHub, custom REST, and invalid policies.

### Phase 1 — Generic managed Connections backend

Files: `server/connections-store.ts`, `server/connections-service.ts`, `server/connections-gateway.ts`, `server/connections-router.ts`, `server/api-schemas.ts`, their tests, and migrations.

Move Jira-specific validation, provisioning, and probes behind registry adapters. Add template catalog and template-neutral creation. Preserve revision conflicts, recent reauthorization, candidate cleanup, quarantine, assignment removal, and restart reconciliation.

Gate: all existing Jira tests remain green without Jira conditionals in the generic service/router; migration tests prove existing rows retain access exactly.

### Phase 2 — Metadata-driven Connections UX

Files: `frontend/src/pages/ConnectionsView.tsx`, `frontend/src/types/connections.ts`, `frontend/src/lib/connections-api.ts`, connection styles, and component/page tests.

Implement catalog, wizard, effective-access review, capability selection, and generalized detail cards. Keep secrets in ephemeral component state and clear them on submit, failure, unmount, and template change.

Gate: accessibility tests cover keyboard flow, validation, secret clearing, risk summaries, stale revision recovery, and mobile layout.

### Phase 3 — Capability execution and audit framework

Files: `server/connections/capabilities/*`, a capability-operation store/migration, `server/codex-chat-session.ts`, approval integration, and tests.

Create typed executor registration, JSON-schema input validation, forced approvals, idempotency, durable operation state, cancellation, redacted failures, and read-after-write verification contracts. Expose eligible capability tools only for the active connection and conversation.

Gate: replaying an idempotency key cannot duplicate an external mutation; denial/cancellation performs no mutation; reconnect can recover the authoritative result.

### Phase 4 — GitHub connection and publish-PR capability

Files: `server/connections/probes/github-readonly.ts`, `server/connections/capabilities/github-publish-pr.ts`, OpenShell transport helpers, schemas, UI manifests, and focused tests.

Implement the execution flow and test matrix above. Keep the sandbox provider read-only. Remove the contradictory direct-push instruction from `server/chat.ts`; tell agents to invoke the structured capability after committing.

Gate: a production-shaped sandbox can commit code, request approval, publish a feature branch, and create/update a PR; it cannot push `main`, force-push, publish to an unapproved repository, or access the host token.

### Phase 5 — Operator custom REST provider builder

Files: registry/compiler modules, gateway adapter, `ConnectionsView` advanced flow, and policy golden tests.

Support the bounded custom schema, technical preview, linting, probe definition, and versioned activation. Do not accept raw YAML or arbitrary executable paths.

Gate: generated profiles round-trip through the pinned OpenShell linter; SSRF, wildcard, redirect, credential, binary, and unknown-field adversarial tests pass.

### Phase 6 — Production migration and acceptance

Files: `infra/openshell/*`, `scripts/verify-openshell-production.mjs`, deployment docs, live-acceptance checklist, and stack lock.

Back up gateway state, deploy code and schema migrations, import reviewed profiles, migrate Jira, configure GitHub scope, and run fresh-conversation plus retained-conversation tests. Rollback must restore the matched Mitzo/OpenShell/profile/database snapshot.

Gate: full CI, production preflight, live identity probes, sandbox GitHub read, approved PR publish, revocation, retained-sandbox fencing, audit visibility, and rollback rehearsal pass.

## Agent allocation

Use Terra as the phase owner. It should implement one phase per PR and stop at every gate. Do not give one agent Phases 1–6 in a single turn.

Good Luna assignments:

- Phase 0 invalid-manifest fixture expansion after Terra defines the registry.
- Phase 2 presentational components after Terra lands API contracts.
- Golden policy fixtures and documentation in Phases 5–6.
- Focused test additions where the production implementation already exists.

Keep the following with Terra or a stronger model: schema migration, gateway lifecycle changes, capability idempotency, OpenShell transport, GitHub publishing, approval semantics, and security review fixes.

## Definition of done

- Each phase lands independently with its gate tests.
- A security review is required for Phases 3–5 before merge.
- No phase weakens the built-in GitHub read-only profile.
- Documentation and the production stack lock describe the actual deployed templates and capabilities.
- Telos child items contain the landed PR, checks, remaining gaps, and next literal step.
