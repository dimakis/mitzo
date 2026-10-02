# Durable closeout live canary

This canary exercises a real setup turn followed by user-initiated closeout through the same
durable admission and provider-attempt machinery used by automatic inactivity closeout. Run it
only against an isolated, non-production controller and disposable repository/seed.

The runner fails before login unless the operator explicitly supplies a Luna model, reasoning
level, account ID, and an acknowledgement matching the exact `account:model` charge identity. It
then requires one completed provider attempt, one completed execution, and final `ENDED` session
state. The user-close lifecycle can take slightly more than two minutes.

```bash
MITZO_PROBE_URL=http://localhost:4311 \
MITZO_PROBE_PASSPHRASE='<isolated-controller-passphrase>' \
MITZO_PROBE_ACCOUNT_ID=work-openai \
MITZO_PROBE_MODEL=gpt-5.6-luna \
MITZO_PROBE_REASONING_EFFORT=medium \
MITZO_PROBE_ACKNOWLEDGE_NON_PRODUCTION=1 \
MITZO_PROBE_ACKNOWLEDGE_CHARGE=work-openai:gpt-5.6-luna \
npm run canary:closeout-live
```

Before running it, state the exact model and billing account to the user. Never inherit a model,
silently fall back to another model, or point the runner at production. Retain the candidate and
prior image/commit, account-profile revision, OpenShell seed/policy/stack lock, sanitized runner
output, and EventStore evidence needed for rollback review.
