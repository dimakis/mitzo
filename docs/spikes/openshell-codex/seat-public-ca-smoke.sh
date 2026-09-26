#!/bin/sh
# Offline physical Landlock regression; no gateway, credentials or model calls.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=7cf1e580ef5539f03b58560753e8ab84c8c360960d99dff714004aa98f203977
tar -C "$source_dir" -cf - symposium-seat-landlock.c seat-public-ca-smoke.py |
  podman run --rm -i --pull=never --network=none \
    --name "symposium-seat-public-ca-smoke-$$" \
    --entrypoint /bin/sh "$image" -ec '
      mkdir /smoke
      tar -C /smoke -xf -
      gcc -O2 -Wall -Wextra -Werror /smoke/symposium-seat-landlock.c -o /usr/local/bin/seat-landlock
      cp /smoke/seat-public-ca-smoke.py /usr/local/bin/ca-smoke.py
      seat=/sandbox/.symposium-seats/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      mkdir -p /sandbox/workspaces/mgmt "$seat" /run/openshell-supervisor-ca/material
      printf public-ca > /run/openshell-supervisor-ca/material/ca.crt
      printf public-bundle > /run/openshell-supervisor-ca/material/ca-bundle.crt
      printf private-marker > /run/openshell-supervisor-ca/material/ca.key
      printf unrelated-marker > /run/unrelated-secret
      ln -s /run/unrelated-secret "$seat/escape"
      export SSL_CERT_FILE=/run/openshell-supervisor-ca/material/ca-bundle.crt
      export NODE_EXTRA_CA_CERTS=/run/openshell-supervisor-ca/material/ca.crt
      cd /sandbox/workspaces/mgmt
      for mode in read write; do
        /usr/local/bin/seat-landlock "$seat" /sandbox/workspaces/mgmt "$mode" /usr/bin/python3 -I -B /usr/local/bin/ca-smoke.py
      done
      rm /run/openshell-supervisor-ca/material/ca.crt
      ln -s /run/unrelated-secret /run/openshell-supervisor-ca/material/ca.crt
      if /usr/local/bin/seat-landlock "$seat" /sandbox/workspaces/mgmt read /usr/bin/true; then
        echo "CA symlink unexpectedly admitted" >&2; exit 1
      fi
      rm /run/openshell-supervisor-ca/material/ca.crt /run/openshell-supervisor-ca/material/ca-bundle.crt
      /usr/local/bin/seat-landlock "$seat" /sandbox/workspaces/mgmt read /usr/bin/true
      echo "Public CA physical Landlock canaries passed"
    '
