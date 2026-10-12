## Staging Vertex refresh profile

Fresh canonical native enrollment uses the reviewed source profile
`infra/openshell/providers/staging-vertex-seat-endpointless.yaml`, SHA256
`0bb081c7a0f651d7a15cca6008d588c747ef3a40306a48a083334eab537698b2`.
It keeps profile ID `google-vertex-ai` inside the original fresh staging gateway's
private workspace. The configured host imports an immutable private copy and
provider creation explicitly passes `--profile-workspace` for that workspace.
Ordinary/global Vertex profiles retain their existing bytes and scopes.

The authorized-user ADC refresh recipe requests cloud-platform and userinfo.email,
uses only `https://oauth2.googleapis.com/token`, and supplies exactly client_id,
client_secret and refresh_token through the original provider creation flow. The
initial authenticated token-info observation must include both scopes and a
verified expected principal. The separate native Describe operation must again
prove the actual current token, principal, recipe and provider after its await.
Public CLI list output does not expose profile_workspace and is not used to
invent that proof. The native gateway checks the actual provider's profile workspace.

The private account capability retains full parsed ADC SHA256 separately from
SHA256 of canonical sorted JSON containing exactly the three refresh material
keys. Public readiness receipts contain neither digest and cannot recreate this
capability. The sole selected model is the explicitly approved Vertex exception
`claude-haiku-4-5@20251001` for project `itpc-ca-638a2a9c7c`, region `global`.
All inference, including auxiliary requests, shares the same two-attempt budget.

An original WeakMap-branded native bootstrap and retained gateway are required
for the staging profile path. Profile bytes, configuration JSON and allocation
permission grant no account or model authority. Source preparation and controlled
offline fixtures do not perform enrollment or prove live feature behavior.
