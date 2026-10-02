#!/bin/sh
# Explicit manual smoke only. No gateway, login, model, or network calls.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Immutable existing local image: do not pull or silently change runtime.
image=7cf1e580ef5539f03b58560753e8ab84c8c360960d99dff714004aa98f203977
tar -C "$source_dir" -cf - symposium-seat-landlock.c \
  symposium-subscription-app-server subscription-landlock-smoke.py |
  podman run --rm -i --pull=never --network=none \
    --name "symposium-subscription-landlock-smoke-$$" \
    --entrypoint /bin/sh "$image" -ec '
      mkdir /smoke
      tar -C /smoke -xf -
      gcc -O2 -Wall -Wextra -Werror /smoke/symposium-seat-landlock.c -o /usr/local/bin/seat-landlock
      cp /smoke/symposium-subscription-app-server /usr/local/bin/
      cp /smoke/subscription-landlock-smoke.py /usr/local/bin/smoke.py
      seat=/sandbox/.symposium-seats/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      mkdir -p /sandbox/workspaces/mgmt "$seat"
      chmod 0700 "$seat"
      cd /sandbox/workspaces/mgmt
      exec /usr/local/bin/seat-landlock "$seat" /sandbox/workspaces/mgmt write /usr/bin/python3 -I -B /usr/local/bin/smoke.py
    '
