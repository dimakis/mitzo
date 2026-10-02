#!/bin/sh
# Disposable, no-network, no-provider probe. Sends only app-server initialize.
set -eu
test "$(codex --version)" = 'codex-cli 0.153.4'
test "$(command -v codex)" = /usr/bin/codex
mkdir -p /sandbox/workspaces/mgmt
claim=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
output="/sandbox/.symposium-control/$claim.stdout"
printf '%s\n' \
  '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"symposium-no-inference-canary","version":"0"},"capabilities":{"experimentalApi":true}}}' \
  '{"method":"initialized","params":{}}' |
  timeout 12 /usr/local/bin/symposium-attempt-controller run "$claim" read \
    /usr/bin/codex app-server --stdio \
    -c 'model_provider="openshell"' \
    -c 'features.enable_request_compression=false' \
    -c 'model_providers.openshell={ name = "OpenShell", base_url = "https://api.openai.com/v1", env_key = "OPENAI_API_KEY", wire_api = "responses" }' \
    >"$output"
grep '"id":1' "$output" >/dev/null
/usr/local/bin/symposium-attempt-controller cancel "$claim" | grep '"terminal":true' >/dev/null
printf 'codex_controller_initialize=passed\n'
