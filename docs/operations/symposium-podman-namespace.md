# Owned Podman namespace evidence

The owned host JSON requires `podman.sandboxNamespace` explicitly. For the pinned
OpenShell Podman driver at `854b2370b8740b67f6481d3015272fc37aaf9427`, use `""`.
This is an exact expected label value, not an omitted check or a wildcard.
Missing, null and whitespace values are rejected. Existing nonempty configured
values remain exact expectations and reject a physical empty label.

At that upstream revision:

- `crates/openshell-server/src/compute/mod.rs:4885` initializes
  `DriverSandbox.namespace` to an empty string.
- The Podman driver does not assign a Kubernetes namespace;
  `crates/openshell-driver-podman/src/container.rs:693` copies the namespace into
  its managed `openshell.ai/sandbox-namespace` label, overriding template labels.
- `crates/openshell-server/src/config_file.rs:1172` tests rejection of the removed
  gateway-scoped `sandbox_namespace` setting. Do not invent this gateway option
  or substitute the Kubernetes driver's namespace configuration.

The verifier still requires matching workspace, sandbox name, sandbox ID,
isolation role, managed marker, exact mount/access and running state. Namespace
acceptance does not replace the retained owned-gateway custody checks. A missing
physical namespace label is not equal to an explicitly empty expected value.

Changing this configuration does not recover an already quarantined creation.
Keep its generation, physical identity, lease and uncertainty receipts until a
reviewed recovery path proves safe cleanup or completion. Do not clear fences or
retry admission merely because physical mount inspection now succeeds.
