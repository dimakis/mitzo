# Publishing from isolated seeded workspaces

Ordinary `RequestGithubPublish` requests use the same account grants, per-repository consent and forced publication approval across Personal ChatGPT, OpenAI API, and Vertex runtimes, with or without OpenShell. A checkout with an origin remote follows the existing committed-history path. An isolated seed has no upstream remote or history and needs the original controller-owned seed baseline.

The controller automatically considers the configured OpenShell seed's sibling `baseline.json`. Register retained baselines through the private deployment configuration:

```dotenv
MITZO_GITHUB_SEED_BASELINES=["/srv/mitzo/seeds/mgmt-v1/baseline.json"]
```

Use absolute host paths to reviewed preparation output, with its sibling `mgmt` repository intact. A baseline identifies the original source repository and upstream commit. The source must still be readable on the controller, and its origin must identify GitHub. The seed's initial tree must exactly match the task repository's initial tree. Missing or ambiguous provenance stops publication; the model cannot supply another baseline or choose a fallback repository. The same-tree mapping must be unique. Unused seed source paths do not block selection of a different valid tree.

The broker reads committed task changes through the existing workspace and Git storage boundary. It rejects dirty workspaces, ambiguous history, oversized approval scope, external Git object storage, and symlink or submodule additions. It exports only the delta after the verified seed; it never copies the entire filtered seed back over upstream files.

After verifying the selected account's connection and repository consent, it creates an isolated private bare clone on the controller, applies the task patch to the selected upstream base using Git's index, and constructs one deterministic commit. No checkout, smudge filter, hook or repository program runs. A conflict stops with `SEEDED_PATCH_CONFLICT`. The task checkout, branch, commit and provider history remain intact.

Publication uses `mitzo/seeded/<original-commit>-<upstream-base>` as its feature branch. This makes each exact source/base pair repeatable without force-pushing a replacement over an older projection. The approval card includes the original task branch and commit, seed tree, patch digest, selected upstream base, projected commit and complete changed-file scope. Revocation, source changes or projection changes stop the operation. The result distinguishes the original commit from the published commit. Success requires verification of both the PR and its remote branch head.

## Operator verification without a model turn

An authenticated interactive operator can POST the ordinary tool input to `/api/sessions/<conversation-id>/github-publication`. This invokes the same registered live publisher and the same forced approval queue; it does not create a model turn. The request cannot specify an account, connection, baseline or fallback actor. The selected ordinary conversation must have a live publishing runtime. A closed runtime or changed account requires opening/resuming that conversation first. Cross-origin requests and Symposium sessions are rejected.

Symposium publication continues through the sealed, reviewed-artifact workflow and its selected credential; this operator route does not publish a seat's mutable workspace.

## Failure diagnostics

Failures before capability dispatch return a diagnostic request ID, stage, safe code and `operationRecorded: false`. Errors after uncertain dispatch do not claim that no operation exists. Recorded operation results include their ID, status and safe failure code. No exception text, subprocess output or credential is returned to a model. An uncertain write remains subject to read-only recovery; neither retries nor account fallback replay it.

Acceptance should cover the shared tool through each provider/runtime combination, user denial, source mutation, revocation, conflicts, a controller restart with the approved base pinned, and remote-head verification. Controlled Git/GitHub fixtures require no model calls. Any real model test must follow the Luna account restriction and canonical staging rules.
