#!/bin/sh
# No-model fixture: prove controller forwards stream JSON and exact stop proof.
set -eu
controller=/usr/local/bin/symposium-attempt-controller
control=/sandbox/.symposium-control
mkdir -p /sandbox/workspaces/mgmt
new_claim() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

natural=$(new_claim)
output="$control/$natural.stdout"
"$controller" run "$natural" read /bin/sh -c \
  'printf "%s\n" "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fixture-thread\"}" "{\"type\":\"assistant\",\"session_id\":\"fixture-thread\",\"message\":{\"id\":\"fixture-message\",\"content\":[{\"type\":\"text\",\"text\":\"Reviewed.\"}]}}" "{\"type\":\"result\",\"session_id\":\"fixture-thread\",\"is_error\":false}"' \
  </dev/null >"$output"
grep '"id":"fixture-message"' "$output" >/dev/null
grep '"type":"result"' "$output" >/dev/null
"$controller" cancel "$natural" | grep '"terminal":true' >/dev/null

stopped=$(new_claim)
stop_output="$control/$stopped.stdout"
"$controller" run "$stopped" read /bin/sh -c \
  'printf "%s\n" "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"cancel-thread\"}"; exec /bin/sleep 30' \
  </dev/null >"$stop_output" &
observer=$!
count=0
while ! grep 'cancel-thread' "$stop_output" >/dev/null 2>&1; do
  count=$((count + 1))
  test "$count" -lt 100
  sleep 0.02
done
"$controller" cancel "$stopped" | grep '"terminal":true' >/dev/null
wait "$observer"
printf 'claude_fixture_stream_and_stop=passed\n'
