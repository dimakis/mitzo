#!/bin/sh
# No model/provider invocation. Parse only installed Claude CLI help in a
# disposable --network none image; never pass a prompt or attach credentials.
set -eu
test "$(command -v claude)" = /usr/local/bin/claude
version=$(claude --version)
test "$version" = '2.1.156 (Claude Code)'
help=$(claude --help)
for flag in \
  --print --bare --disable-slash-commands --strict-mcp-config --verbose \
  --output-format --include-partial-messages --model --effort --tools \
  --permission-mode --append-system-prompt --resume --session-id; do
  printf '%s\n' "$help" | grep -- "$flag" >/dev/null
done
printf '%s\n' "$help" | grep 'only works with --print and' >/dev/null
printf '%s\n' "$help" | grep 'output-format=stream-json' >/dev/null
printf '%s\n' "$help" | grep 'choices: "acceptEdits"' >/dev/null
printf '%s\n' "$help" | grep '"plan")' >/dev/null
printf '%s\n' "$help" | grep 'must be a valid UUID' >/dev/null
for name in ANTHROPIC_VERTEX_BASE_URL CLAUDE_CODE_SKIP_VERTEX_AUTH CLAUDE_CODE_USE_VERTEX; do
  grep -a -q "$name" /usr/local/bin/claude
done
printf 'claude_argv_help=passed version=%s\n' "$version"
