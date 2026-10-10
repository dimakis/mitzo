# Reusable agent context

Knowledge's **Context** tab manages versioned reusable packs. Agent Library's **Context** editor selects those same published packs. Agent identity, behavior and recipe are independent of account, model and runtime selection. A general reviewer can compose core guidance and review practice; a Mitzo reviewer can add architecture and testing guidance without copying the shared packs.

## Curation and revisions

A pack has a stable ID, name, purpose, preview budget, source selections, retrieval guidance and optional rationale. Each document reference pins a relative Knowledge path and an accepted Git revision. Required/prioritized/excluded sections use Markdown heading ancestry without the filename; matching is case-insensitive, and a parent selects its descendants. Missing or ambiguous selectors fail validation. Fenced code cannot declare a heading.

**Save draft** preserves a recoverable working copy. **Compile preview** resolves the accepted references and reports the payload, included/omitted sections, token estimate and provenance. **Publish** validates and compiles that exact saved draft, then appends an immutable revision. It publishes reusable configuration in the private Knowledge database; it does not modify or publish Knowledge documents. A stale draft cannot publish over a newer accepted pack revision. Create/save retries retain their original request identity.

History exposes previous definitions and comparisons. Publishing a reverted definition creates another revision. Impact lists show the profile revisions that pin a pack. A profile's historical pin is resolved by exact ID/revision/hash even when a newer pack exists; it is never silently upgraded. To adopt newer packs, edit and publish the profile, then start a new chat on a supported ordinary route. Updating a native Symposium profile does not enable pack delivery.

**Create context with advisor** opens a normal chat with bounded accepted source references and the selected saved pack metadata. It asks the agent for a portable proposal and rationale. Import the proposed JSON as a draft, inspect it, then save/publish explicitly. This flow performs no simulated advisor response and grants no source, tool or publishing permission. Profile creation also supports the existing proposal tool when exposed.

## Compilation contract

```json
{
  "version": 2,
  "source": "packs",
  "packs": [
    {
      "id": "core",
      "revision": 2,
      "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "id": "mitzo-review",
      "revision": 1,
      "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "tokenBudget": 18000
}
```

The example hashes are placeholders. The editor selects actual published hashes. The profile's `tokenBudget` caps the composed result; each pack's budget controls its standalone preview/default. Required sections and retrieval guidance must fit. Optional sections are ordered by priority and may be trimmed. Overlapping selections deduplicate content; conflicting source revisions, required/excluded overlaps or inconsistent bytes for one immutable source identity fail compilation.

The pinned ContexGin dependency compiles preloaded accepted documents, never an inferred task checkout. The host's existing Knowledge enrollment selects the source namespace and permitted paths. Runtime admission supplies that authorization; profiles cannot select private host paths, service URLs, accounts or credentials. Pack text/import validation also rejects credentials, machine paths and transcript dumps. Sources are bounded to 64 KiB per document, 1 MiB of unique immutable documents per composition and 500 sections. Repeated section selections share the byte budget while still verifying that repeated reads have identical content.

Profile admission resolves the exact profile/recipe/pack revisions, authorizes source access, compiles, persists the snapshot, then dispatches. The snapshot contains compiler/recipe/payload hashes, pack pins, accepted document revisions/content hashes, source namespace, budget and omissions. Source changes do not mutate an existing snapshot. Resumes recheck current scopes and accepted ancestry using Git metadata; a revoked/removed revision blocks dispatch while preserving the snapshot and history.

## Runtime delivery

Ordinary Claude SDK, OpenAI Responses and Gemini/Vertex host-loop chats support pack recipes. They consume the prepared profile snapshot before dispatch and recheck source authority at each application-owned provider request, including tool-result continuations. Claude SDK pack recipes disable automatic project instruction loading and project SessionStart boot hooks; other hook/tool policy remains independently enforced.

Native Codex pack routes are unavailable, including local and OpenShell chats, native Symposium API and subscription seats, and approved native search threads. The current native runtime has no trusted pre-provider continuation barrier for every provider request. Native Claude Symposium seats also reject recipe-bearing profiles before setup or spawn; native Gemini Symposium dispatch is unsupported. Choose a profile without a context recipe for native Codex or Claude Symposium seats. Pack definitions and profile curation remain independent of account, model and runtime.

Native delivery integration code is preparation, not admitted support. Settings that disable project document loading and application-level tool callbacks cannot establish the missing native barrier. Native Codex pack support requires a reviewed native build and explicit runtime enrollment that enforce current source authority before every provider continuation. No configuration flag enables that support.

On supported ordinary routes, an admitted operator scope remains watched through setup and execution. Logout/expiry cancels the run; actual provider dispatch rechecks context authority and accepted-source metadata. SDK tool-result batches, nested-agent startup and compaction also recheck that authority before continuing. Existing hooks and permission callbacks retain their behavior, with a final recheck after asynchronous work; revoked sources abort the owning run while preserving historical receipts. New authenticated recovery uses the existing cold-resume admission. Recipes do not expand filesystem, network or tool grants.

Conversation disclosure labels a snapshot **Prepared** until real provider evidence arrives. On supported pack routes, Claude SDK provider message-start, OpenAI Responses response creation and Vertex's actual returned response ID establish their respective delivery associations. Codex turn acknowledgement applies to supported legacy workspace/preset recipes; it does not admit native packs. A missing Vertex response ID remains prepared. These receipts associate the supplied snapshot/instruction hash with an exact provider response; they do not claim the provider echoed the entire context. Legacy OpenShell delivery hashes the persistent instructions and per-turn retrieval delta as separate channels. Historical acknowledgements remain recorded if authority is subsequently revoked.

## Storage, APIs and rollout

Pack drafts/revisions/retry records share the existing private Knowledge `drafts.sqlite`; profile and conversation snapshots remain in their existing stores. Published pack and prepared-seat rows are immutable. Existing SQLite backup covers these tables. Portable profile exports contain recipe references, not compiled run bodies; dependency packs must exist or be explicitly remapped and republished on another host.

`/api/context-packs` exposes catalog, immutable revision/history, impact, draft/save, validation, preview and publication endpoints. Operator authentication, same-origin JSON writes, bounded requests and revocation during validation are enforced. In custodian mode, closed operation mappings send these routes to the retained owner. Agent Library preview and runtime startup use the same enrolled source and pack store.

Knowledge enrollment remains opt-in through `MITZO_KNOWLEDGE_LIBRARY_CONFIG`. Missing configuration fails pack admission explicitly. Legacy version 1 workspace/preset recipes support local chats and reviewed managed OpenShell sandbox compilation. Native Codex pack recipes and native Claude Symposium context recipes remain unavailable; native Gemini Symposium dispatch is unsupported. Ordinary Claude SDK, OpenAI Responses and Gemini/Vertex chats support packs. Implementation/tests do not deploy, enroll providers, change live configuration or make model calls. Live acceptance uses canonical staging and an explicitly selected supported Luna model/account; production activation remains a separate user action.
