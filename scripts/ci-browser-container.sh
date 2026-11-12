#!/usr/bin/env bash
# Keep compilation/native npm installation on the Ubuntu runner. Execute only
# the browser consumer in the same Ubuntu/architecture with its exact Node and
# job-local dependencies, plus digest-pinned preinstalled browser dependencies.
set -euo pipefail
: "${GITHUB_WORKSPACE:?CI workspace required}"
: "${RUNNER_TEMP:?CI temporary directory required}"
: "${RUNNER_TOOL_CACHE:?CI tool cache required}"
: "${GITHUB_RUN_ID:?CI run identity required}"
if [[ ${RUNNER_OS:-} != Linux ]]; then
  echo 'CI_BROWSER_CONTAINER_PLATFORM: this wrapper requires a Linux CI runner' >&2
  exit 1
fi
image='mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27'
node_directory=$(dirname "$(command -v node)")
case "$node_directory/" in
  "$RUNNER_TOOL_CACHE/"*) ;;
  *) echo 'CI_BROWSER_NODE_CUSTODY: Node must come from the selected runner tool cache' >&2; exit 1 ;;
esac
browser_temp="$RUNNER_TEMP/ci-browser"
mkdir -p "$browser_temp/home" "$browser_temp/tmp"
name="mitzo-browser-${GITHUB_RUN_ID}-$$"
docker_client_pid=''
args=(run --rm --init --pull=never --ipc=host --name "$name"
  --user "$(id -u):$(id -g)"
  --volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE"
  --volume "$browser_temp:$browser_temp"
  --volume "$RUNNER_TOOL_CACHE:$RUNNER_TOOL_CACHE:ro"
  --workdir "$GITHUB_WORKSPACE"
  --env "PATH=$node_directory:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  --env "HOME=$browser_temp/home"
  --env "RUNNER_TEMP=$browser_temp"
  --env "TMPDIR=$browser_temp/tmp")
if [[ -n ${S9_MGMT_PYTHON:-} ]]; then
  venv="$RUNNER_TEMP/telos-s9-python"
  if [[ $S9_MGMT_PYTHON != "$venv/bin/python" ]]; then
    echo 'CI_BROWSER_PYTHON_CUSTODY: unexpected canonical CLI environment' >&2
    exit 1
  fi
  args+=(--volume "$venv:$venv:ro")
fi
# Explicitly retain test/run attribution without forwarding tokens or credentials.
for variable in CI GITHUB_ACTIONS GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_JOB GITHUB_WORKSPACE RUNNER_OS NODE_OPTIONS S9_MGMT_PYTHON S9_SUPPLEMENTAL_PORTABLE_CLI; do
  args+=(--env "$variable")
done
cancel() {
  trap '' INT TERM
  local diagnostic="$RUNNER_TEMP/$name-cleanup.log"
  # Retire the client before reconciling the owned name: an unfinished `run`
  # could otherwise create/start the container after stop reports it absent.
  # jobs covers cancellation between background launch and PID assignment.
  local client_pid=${docker_client_pid:-$(jobs -pr)}
  if [[ -n $client_pid ]]; then
    if kill -0 "$client_pid" 2>/dev/null && ! kill -KILL "$client_pid" 2>"$diagnostic"; then
      echo "CI_BROWSER_CLIENT_CLEANUP: failed to retire Docker client $client_pid" >&2
      cat "$diagnostic" >&2
    fi
    local client_exit=0
    wait "$client_pid" 2>"$diagnostic" || client_exit=$?
    if [[ $client_exit == 127 ]]; then
      echo "CI_BROWSER_CLIENT_CLEANUP: Docker client $client_pid could not be joined" >&2
      cat "$diagnostic" >&2
    fi
  fi
  if ! docker stop --time 10 "$name" 2>"$diagnostic" && ! grep -Fq 'No such container' "$diagnostic"; then
    echo "CI_BROWSER_CONTAINER_CLEANUP: failed to stop $name after cancellation" >&2
    cat "$diagnostic" >&2
  fi
  # Stop alone leaves a created, unstarted container available to a pending start.
  if ! docker rm --force "$name" 2>"$diagnostic" && ! grep -Fq 'No such container' "$diagnostic"; then
    echo "CI_BROWSER_CONTAINER_CLEANUP: failed to remove $name after cancellation" >&2
    cat "$diagnostic" >&2
  fi
  exit "$1"
}
trap 'cancel 130' INT
trap 'cancel 143' TERM
run_container() {
  # Waiting on a background CLI lets the shell handle cancellation immediately.
  docker "${args[@]}" "$image" "$@" &
  docker_client_pid=$!
  wait "$docker_client_pid"
  docker_client_pid=''
}
if [[ ${1:-} == --prepare ]]; then
  shift
  docker pull "$image"
  run_container node -e '
    const fs = require("node:fs");
    const version = require("playwright-core/package.json").version;
    if (version !== "1.63.0" || process.env.PLAYWRIGHT_BROWSERS_PATH !== "/ms-playwright")
      throw new Error("CI_PLAYWRIGHT_IMAGE_MISMATCH: update the image alongside the Playwright lockfile");
    const playwright = require("playwright-core");
    for (const name of process.argv.slice(1)) {
      if (!["chromium", "webkit", "firefox"].includes(name)) throw new Error(`Unsupported browser: ${name}`);
      const executable = playwright[name].executablePath();
      fs.accessSync(executable, fs.constants.X_OK);
      console.log(`Using preinstalled ${name} ${version}: ${executable}`);
    }
  ' "$@"
else
  run_container "$@"
fi
