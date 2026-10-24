# Current required source: nine cases in seven sequential groups

The dedicated `run-joined-ci.mjs` now includes the independently qualified Stop/isolation contract via `vitest.stop-isolation.config.ts`. The original eight selections and exact-file/count/zero-skip guards are unchanged. The same-account ordinary comparison is a separate bounded observation, not a tenth required case. `S9-NINE-CASE-RUNNER-PROOF.json` in the S9 workspace records exact source/count proof.

No complete nine-case local/hosted run is claimed. S5b owns eventual #1048 workflow adoption after production dependencies. Retain private Python/PyYAML/Chromium, macOS artifact admission, one worker/1GiB, exact current-head CI and trusted Centaur/App gates. Final accepted-main combined qualification remains required. Previous scopes below remain historical evidence.

---

# Joined S9 cases in the existing macOS offline job

The current `ordinary-journey` job in `.github/workflows/ci.yml` selects the two
producer native tests explicitly. It does **not** execute the new S9 `.contract.ts`
cases. Green default CI is not joined browser qualification. No workflow was
changed here; adoption belongs with that existing owner after usable production
dependencies and the required repository journey are green.

The dedicated runner is
`tests/integration/telos-s9/integrated-candidate/run-joined-ci.mjs`. It runs the
non-Git, repository, lost-response recovery, tree/priority and S8 chooser configs, then the three
published actual-App owner cases, sequentially with one worker and a 1 GiB Node heap.
Separate raw reports/logs/captures are retained. Each case must pass exactly once with
zero failures or skips. Linux refuses this native macOS qualification instead of
silently skipping it. The historical operator-group peer503 case is separate;
passing these cases does not close that separate group route or full UI acceptance.

The final owner config explicitly selects the unchanged canonical CT09,
`agent-communication-nongit-app.test.ts` and
`telos-coordinator-v2-native-journey.test.ts` contracts published at faad2c8b.
The guard requires exactly three files with one passing assertion each and no
skips, in addition to the five individual browser cases. The existing macOS
artifact-platform check remains required in its owning workflow. This runner
does not edit producer tests or create a global workflow owner.

The source fixture contains only the 39 tracked Python files previously executed
from accepted MGMT `3077b7b4dcdf0ef097062794b2ab93d33c1d89ad`. Its compressed
archive and every file are hashed, and the loader verifies them before writing
into the private temporary controller fixture. No external MGMT checkout,
`.git`, user YAML, profiles, credentials or live database is required. The actual
CLI reads the synthetic canonical DB and an empty private manual YAML. Refresh,
enrichment, writes and workload publication are not invoked.

Select Python3.11 or later (3.13 is used for the isolated local verification),
create a private test venv, and install its read dependency using the retained
accepted-lock artifact hashes:

```sh
python3 -m venv "$RUNNER_TEMP/s9-mgmt-read-python"
"$RUNNER_TEMP/s9-mgmt-read-python/bin/python3" -m pip install --require-hashes \
  -r tests/integration/telos-s9/integrated-candidate/fixtures/mgmt-read-requirements.txt
npx playwright install chromium
S9_MGMT_PYTHON="$RUNNER_TEMP/s9-mgmt-read-python/bin/python3" \
  NODE_OPTIONS=--max-old-space-size=1024 \
  node tests/integration/telos-s9/integrated-candidate/run-joined-ci.mjs
```

Existing npm/workspace package preparation remains required. The runner always
uses bundled accepted source; direct config runs may optionally supply
`S9_MGMT_SOURCE_ROOT` only when its exact3077 Git files match the same manifest.
Python user sites and `PYTHONPATH` are excluded. The original frozen non-Git and
repository case files/assertions are unchanged by this portability preparation.

The historical repository firstSend failure on84cf and later exact retry409 on798
remain retained failures. On frozen85847f51, the same corrected-observer repository
case passes, including real first admission, output/review, exact consumed retry
without dispatch, and reopened owners. Its observer corrections follow the actual
V1 receipt and reserved-to-claimed lifecycle; original frozen9fdb bytes remain
archived. Exact combined-source local execution is recorded separately from this
recipe. Workflow adoption, hosted execution and exact-head required CI remain
pending; this runner's existence does not establish a hosted result.

The prior85c runner passed seven cases on exact858 production. The later bounded
tree/priority journey adds an eighth required case. The enhanced S8 chooser case
also adds approved previous/additional label assertions and currently fails on858.
Historical seven-case green remains scoped evidence; the current eight-case runner
is not qualified until the owning read-projection/render correction is integrated.

The corrected union d525a364 is now integrated in S9 b8fd3a5a. The unchanged
enhanced chooser case passes1/0skip16.69s there. The eight-case runner still needs
its complete dependency-ready hosted execution; neither the old seven-case local
run nor this bounded retake supplies that result.
