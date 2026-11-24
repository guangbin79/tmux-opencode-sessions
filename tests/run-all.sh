#!/usr/bin/env bash
# Full test suite: syntax checks + TUI stub-driver tests + isolated-tmux
# renderer tests + installer tests. Exit non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "== syntax checks =="
if node -e "import('./plugins/tui.js').then(() => console.log('plugins/tui.js ok'))"; then
  :
else
  echo "FAIL: plugins/tui.js import/syntax"
  fail=1
fi
for sh in scripts/*.sh install.sh opencode-sessions.tmux; do
  [ -f "$sh" ] || continue
  if bash -n "$sh"; then
    echo "bash -n $sh ok"
  else
    echo "FAIL: bash -n $sh"
    fail=1
  fi
done

echo "== tui stub-driver tests =="
mkdir -p /tmp/opencode
for t in tests/tui/*.test.mjs; do
  log=$(mktemp /tmp/opencode/fake-tmux.XXXXXX)
  # tests/helpers/tmux shadows the real binary only for these node runs.
  FAKE_TMUX_LOG=$log PATH="$PWD/tests/helpers:$PATH" node "$t" || fail=1
  rm -f "$log"
done

echo "== renderer tests (isolated tmux) =="
for t in tests/renderer/*.sh; do
  [ -f "$t" ] || continue
  bash "$t" || fail=1
done

echo "== installer tests =="
if [ -f tests/installer/test.sh ]; then
  bash tests/installer/test.sh || fail=1
fi

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; fi
exit $fail
