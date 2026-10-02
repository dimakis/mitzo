#!/bin/sh
set -eu

src="$(dirname "$0")"
launcher=/usr/local/bin/symposium-seat-landlock
if [ ! -x "$launcher" ]; then
  gcc -O2 -Wall -Wextra -Werror "$src/symposium-seat-landlock.c" -o /tmp/symposium-seat-landlock
  launcher=/tmp/symposium-seat-landlock
fi
home_a=/sandbox/.symposium-seats/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
home_b=/sandbox/.symposium-seats/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
workspace=/sandbox/workspaces/mgmt
mkdir -p "$home_a" "$home_b" "$workspace"
printf own > "$home_a/own"
printf secret > "$home_b/secret"
ln -s "$home_b/secret" "$home_a/escape"

"$launcher" "$home_a" "$workspace" read /bin/sh -eu -c '
  test "$(cat "$HOME/own")" = own
  test "$(cat /etc/os-release | head -1)" != ""
  ! cat /sandbox/.symposium-seats/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/secret >/dev/null 2>&1
  ! cat "$HOME/escape" >/dev/null 2>&1
  ! cat /proc/self/environ >/dev/null 2>&1
  ! sh -c "printf test > /sandbox/workspaces/mgmt/read-mode-escape" 2>/dev/null
  ! sh -c "printf test > /tmp/read-mode-escape" 2>/dev/null
'

"$launcher" "$home_a" "$workspace" write /bin/sh -eu -c '
  printf local > "$HOME/created"
  printf shared > /sandbox/workspaces/mgmt/write-mode-positive
  test "$(cat "$HOME/created")" = local
  test "$(cat /sandbox/workspaces/mgmt/write-mode-positive)" = shared
  ! cat /sandbox/.symposium-seats/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/secret >/dev/null 2>&1
  ! sh -c "printf bad > /tmp/write-mode-escape" 2>/dev/null
'
printf 'Landlock private HOME, shared workspace, read-only, symlink and proc canaries passed\n'
