These public, credential-free fixtures are the actual output of a standalone
Rust probe linked to `openshell-policy` at OpenShell commit `854b2370b`.
`input.json` came from the existing Vertex seat policy compiler plus the reviewed
staging filesystem/Landlock policy. `canonical.json` is
`parse_sandbox_policy` → `sandbox_policy_to_json_value` output. No gateway,
provider, credential, or inference was used. The only semantic-default omissions
are the two explicit false endpoint credential options. The project identifier
is a public route selector, not credential or model-availability evidence.
