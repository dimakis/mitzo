#!/bin/sh
# Explicit no-network/no-model image-local regression. No host mounts or auth.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d
tar -C "$source_dir" -cf - normalize-symposium-codex.py symposium-seat-landlock.c |
  podman run --rm -i --pull=never --network=none \
    --name "symposium-canonical-codex-smoke-$$" --user 0 --entrypoint /bin/sh "$image" -ec '
      mkdir /smoke; tar -C /smoke -xf -
      check=/smoke/normalize-symposium-codex.py
      if python3 "$check" --check; then echo "npm shim unexpectedly accepted" >&2; exit 1; fi
      gcc -O2 -Wall -Wextra -Werror /smoke/symposium-seat-landlock.c -o /usr/local/bin/test-seat-landlock
      seat=/sandbox/.symposium-seats/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      mkdir -p "$seat" /sandbox/workspaces/mgmt
      if /usr/local/bin/test-seat-landlock "$seat" /sandbox/workspaces/mgmt read /usr/bin/codex --version; then
        echo "seat bootstrap unexpectedly accepted npm shim" >&2; exit 1
      fi
      python3 "$check" --install
      python3 "$check" --check
      python3 "$check" --install
      /usr/local/bin/test-seat-landlock "$seat" /sandbox/workspaces/mgmt read /usr/bin/codex --version
      /usr/local/bin/test-seat-landlock "$seat" /sandbox/workspaces/mgmt write /usr/bin/codex --version
      python3 - <<"PY"
import os, subprocess, time
p = subprocess.Popen(["/usr/bin/codex", "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            identity = os.readlink(f"/proc/{p.pid}/exe")
            if identity == "/usr/bin/codex":
                break
        except FileNotFoundError:
            pass
        time.sleep(.01)
    assert identity == "/usr/bin/codex", identity
    print("Kernel executable identity matches unchanged exact policy path")
finally:
    p.terminate()
    p.wait(timeout=5)
PY
      printf invalid >> /usr/bin/codex
      if python3 "$check" --check; then echo "mutated binary accepted" >&2; exit 1; fi
      printf invalid >> /usr/lib/node_modules/@openai/codex/package.json
      if python3 "$check" --install; then echo "unreviewed package accepted" >&2; exit 1; fi
      echo "Canonical native Codex regression passed"
    '
