# Discovery claim label contract

The discovery journal and native attempt controller use a random 256-bit claim,
represented as 64 lowercase hexadecimal characters. Passing that string directly
as an OpenShell sandbox label is invalid: upstream label values allow at most
63 characters.

The host now sends `mitzo.discovery.claim=v1.<base64url claim bytes>.c`. This
48-character encoding preserves all 256 bits and has fixed alphanumeric ends,
including when the base64url payload ends with `-` or `_`. Both discovery ownership
checks and the workspace creation fence compare this exact encoding. The journal
and native controller retain the original hex claim; no metadata migration occurs.

## Evidence and limits

The isolated staging CLI and gateway report `0.0.117-dev.292+g854b2370b`.
Their file hashes match their owned-host configuration pins. In upstream commit
`854b2370b8740b67f6481d3015272fc37aaf9427`,
`crates/openshell-server/src/grpc/sandbox.rs:420` calls
`validate_create_sandbox_request_pre_io`; its label validation at line 714 invokes
`validation.rs:843`, which rejects a 64-character value before workspace lookup
or sandbox creation. The existing upstream test
`validate_label_value_rejects_too_long` uses exactly 64 characters.

The host regression rejects an invalid label using this upstream contract. It
failed before the encoding change and passes afterward. Discovery, creation-fence,
and custody mocked tests cover the encoded identity through completion and
cleanup. These tests perform no live inference or sandbox creation.

This is a deterministic defect in the old create request. It does not recover the
lost command error or automatically clear any old uncertain journal, workspace
fence, or connection quarantine. Any recovery must separately prove exact request
identity and custody and follow reviewed recovery logic. Empty inventory remains
insufficient proof. This fix does not claim a successful live discovery.
