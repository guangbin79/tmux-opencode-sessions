#!/usr/bin/env bash
# Renderer byte-exactness tests against an isolated tmux server.
# Asserts exact output bytes (colors, leading space, zero-byte rule).
set -uo pipefail
cd "$(dirname "$0")/../.."
sock="oc-rt-$$"
fail=0
tmux -L "$sock" -f /dev/null new-session -d -x 120 -y 8
trap 'TMUX= tmux -L "$sock" kill-server 2>/dev/null' EXIT
pane=$(TMUX= tmux -L "$sock" display-message -p '#{pane_id}')
# Route the bare `tmux` inside pane-sessions.sh to the isolated server.
export TMUX="/tmp/tmux-$(id -u)/$sock,99999,0"
set_env() { TMUX= tmux -L "$sock" set-environment -g "$1" "$2"; }
out_file=$(mktemp /tmp/opencode/render.XXXXXX)
render() { : > "$out_file"; bash scripts/pane-sessions.sh "$1" > "$out_file"; cat "$out_file"; }
bytes() { wc -c < "$out_file"; }

check_eq() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok: $1"; else echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual:   [$3]"; fail=1; fi
}

# 1. no registrations at all → zero bytes
render "$pane" > /dev/null
check_eq "no keys: zero bytes" 0 "$(bytes)"

# 2. binding fixture: running + idle
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle"
check_eq " [R I] exact bytes" \
  ' [#[fg=blue]R#[fg=default] I]' \
  "$(render "$pane")"

# 3. binding fixture: done + waiting + waiting
set_env "TMUX_OPENCODE_TUI_$$_STATES" "done needs-input needs-input"
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c"
check_eq " [D Q Q] exact bytes" \
  ' [#[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$pane")"

# 4. full color table, one of each state
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c ses_d"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle done needs-input"
check_eq "all four letters/colors" \
  ' [#[fg=blue]R#[fg=default] I #[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$pane")"

# 5. never emits the forbidden #[default]
if grep -q '#\[default\]' "$out_file"; then echo "FAIL: #[default] emitted"; fail=1; else echo "ok: no #[default]"; fi

# 6. other panes are ignored
set_env "TMUX_OPENCODE_TUI_$$_PANE" "%424242"
render "$pane" > /dev/null
check_eq "foreign pane id: zero bytes" 0 "$(bytes)"
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$pane"

# 7. dead TUI pid is ignored
sleep 0.05 & dead=$!; wait $dead
set_env "TMUX_OPENCODE_TUI_${dead}_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_${dead}_SESSIONS" "ses_dead"
set_env "TMUX_OPENCODE_TUI_${dead}_STATES" "running"
check_eq "dead pid contributes nothing" \
  ' [#[fg=blue]R#[fg=default] I #[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$pane")"

# 8. invalid session id is skipped; invalid/missing state renders idle
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "@@@ ses_b ses_c ses_d"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running garbage"
check_eq "invalid sid skipped, invalid state→idle, missing state→idle" \
  ' [I I I]' \
  "$(render "$pane")"

# 9. two live TUIs on one pane merge in pid order
sleep 5 & live=$!
set_env "TMUX_OPENCODE_TUI_${live}_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_${live}_SESSIONS" "ses_e"
set_env "TMUX_OPENCODE_TUI_${live}_STATES" "idle"
check_eq "multi-TUI merge" \
  ' [I I I I]' \
  "$(render "$pane")"
kill $live 2>/dev/null

# 10. SESSIONS present but empty → zero bytes
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" ""
set_env "TMUX_OPENCODE_TUI_$$_STATES" ""
render "$pane" > /dev/null
check_eq "empty session list: zero bytes" 0 "$(bytes)"

rm -f "$out_file"
exit $fail
