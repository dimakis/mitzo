# Claude Vertex seat policy for OpenShell 0.1.0

Import `vertex-seat-endpointless.yaml` into the Symposium workspace as the
`google-vertex-ai` profile. This replaces the broad example profile in that
workspace. The provider must be created in that workspace so its
`profile_workspace` resolves to this override. Never attach a provider that
still resolves to the example profile's wildcard Vertex endpoints.

For each Claude seat, call `createVertexSeatPolicy` with the **selected account
profile's exact** project, region, pinned provider name, and the executable
path observed in the sandbox. The only accepted model is
`claude-haiku-4-5@20251001`. Add the separately reviewed filesystem policy and
write the result as the sandbox's initial policy before attaching the provider
or launching Claude. The generator allows only POST to that project's two
Haiku `rawPredict` and `streamRawPredict` paths on the exact regional host.
The provider's opaque bearer placeholder resolves only inside the bound
endpoint paths. The policy names the exact `claude` executable; verify that
the sandbox image runs a native executable at that path and that OpenShell
reports binary attribution for it. A script launched by `node` needs a
different reviewed executable boundary.

Before a live test, inspect the **effective** sandbox policy and resolved
provider profile. Confirm there are no additional Vertex endpoints or broad
network rules, the endpointless profile is active, and the global policy does
not suppress the sandbox policy. Test denied alternate project, region, model,
method, host, and process paths without credentials before making the approved
Haiku model call. No profile import, sandbox mutation, or model call is made by
these files.
