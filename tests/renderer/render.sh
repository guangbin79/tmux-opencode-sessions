#!/usr/bin/env bash
# Window renderer byte-exactness tests against an isolated tmux server.
# Asserts exact output bytes (colors, leading space, zero-byte rule,
# per-pane grouping, pane_index ordering).
set -uo pipefail
cd "$(dirname "$0")/../.."
sock="oc-rt-$$"
fail=0
tmux -L "$sock" -f /dev/null new-session -d -x 120 -y 8
trap 'TMUX= tmux -L "$sock" kill-server 2>/dev/null' EXIT
# The server inherits the driver's exported environment; drop any live
# TMUX_OPENCODE_TUI_* registration so dynamic pane ids stay deterministic.
for key in $(TMUX= tmux -L "$sock" show-environment -g | sed -n 's/^\(TMUX_OPENCODE_TUI_[^=]*\)=.*/\1/p'); do
  TMUX= tmux -L "$sock" set-environment -gu "$key"
done
win=$(TMUX= tmux -L "$sock" display-message -p '#{window_id}')
pane=$(TMUX= tmux -L "$sock" display-message -p '#{pane_id}')
# Route the bare `tmux` inside window-sessions.sh to the isolated server.
export TMUX="/tmp/tmux-$(id -u)/$sock,99999,0"
set_env() { TMUX= tmux -L "$sock" set-environment -g "$1" "$2"; }
out_file=$(mktemp /tmp/opencode/render.XXXXXX)
render() { : > "$out_file"; bash scripts/window-sessions.sh "$1" > "$out_file"; cat "$out_file"; }
bytes() { wc -c < "$out_file"; }

check_eq() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok: $1"; else echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual:   [$3]"; fail=1; fi
}

# 1. no registrations at all → zero bytes
render "$win" > /dev/null
check_eq "no keys: zero bytes" 0 "$(bytes)"

# 2. binding fixture: running + idle
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle"
check_eq " [R I] exact bytes" \
  ' [#[fg=blue]R#[fg=default] I]' \
  "$(render "$win")"

# 3. binding fixture: done + waiting + waiting
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "done needs-input needs-input"
check_eq " [D Q Q] exact bytes" \
  ' [#[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$win")"

# 4. full color table, one of each state
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c ses_d"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle done needs-input"
check_eq "all four letters/colors" \
  ' [#[fg=blue]R#[fg=default] I #[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$win")"

# 5. never emits the forbidden #[default]
if grep -q '#\[default\]' "$out_file"; then echo "FAIL: #[default] emitted"; fail=1; else echo "ok: no #[default]"; fi

# 6. a registration for a pane id that exists nowhere is ignored
set_env "TMUX_OPENCODE_TUI_$$_PANE" "%424242"
render "$win" > /dev/null
check_eq "foreign pane id: zero bytes" 0 "$(bytes)"
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$pane"

# 6b. registration on another window's pane renders nothing for this window
other_pane=$(TMUX= tmux -L "$sock" new-window -d -P -F '#{pane_id}')
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$other_pane"
render "$win" > /dev/null
check_eq "foreign window: zero bytes" 0 "$(bytes)"
set_env "TMUX_OPENCODE_TUI_$$_PANE" "$pane"

# 7. dead TUI pid is ignored
sleep 0.05 & dead=$!; wait $dead
set_env "TMUX_OPENCODE_TUI_${dead}_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_${dead}_SESSIONS" "ses_dead"
set_env "TMUX_OPENCODE_TUI_${dead}_STATES" "running"
check_eq "dead pid contributes nothing" \
  ' [#[fg=blue]R#[fg=default] I #[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$win")"

# 8. invalid session id is skipped; invalid/missing state renders idle
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "@@@ ses_b ses_c ses_d"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running garbage"
check_eq "invalid sid skipped, invalid state→idle, missing state→idle" \
  ' [I I I]' \
  "$(render "$win")"

# 9. two live TUIs on one pane merge into one group in pid order
sleep 60 & live=$!
set_env "TMUX_OPENCODE_TUI_${live}_PANE" "$pane"
set_env "TMUX_OPENCODE_TUI_${live}_SESSIONS" "ses_e"
set_env "TMUX_OPENCODE_TUI_${live}_STATES" "idle"
check_eq "multi-TUI merge" \
  ' [I I I I]' \
  "$(render "$win")"
kill $live 2>/dev/null

# 10. SESSIONS present but empty → zero bytes
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" ""
set_env "TMUX_OPENCODE_TUI_$$_STATES" ""
render "$win" > /dev/null
check_eq "empty session list: zero bytes" 0 "$(bytes)"

# 11. multi-pane window: one bracket group per pane, in pane_index order
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle"
pane1=$(TMUX= tmux -L "$sock" split-window -d -P -F '#{pane_id}' -t "$win")
sleep 60 & live2=$!
set_env "TMUX_OPENCODE_TUI_${live2}_PANE" "$pane1"
set_env "TMUX_OPENCODE_TUI_${live2}_SESSIONS" "ses_f ses_g"
set_env "TMUX_OPENCODE_TUI_${live2}_STATES" "done needs-input"
check_eq "multi-pane: [R I] [D Q]" \
  ' [#[fg=blue]R#[fg=default] I] [#[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]]' \
  "$(render "$win")"

# 12. pane_index (not pane_id) decides group order: swap pane positions
TMUX= tmux -L "$sock" swap-pane -s "$pane1" -t "$pane"
check_eq "swapped panes reorder groups by pane_index" \
  ' [#[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default]] [#[fg=blue]R#[fg=default] I]' \
  "$(render "$win")"
kill $live2 2>/dev/null

# 13. agora idle markers: all six state letters in one group (A blue, I* yellow)
set_env "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c ses_d ses_e ses_f"
set_env "TMUX_OPENCODE_TUI_$$_STATES" "running idle done needs-input agora agora-blocked"
check_eq "all six state letters incl. agora markers" \
  ' [#[fg=blue]R#[fg=default] I #[fg=red]D#[fg=default] #[fg=yellow]Q#[fg=default] #[fg=blue]A#[fg=default] #[fg=yellow]I*#[fg=default]]' \
  "$(render "$win")"
if grep -q '#\[default\]' "$out_file"; then echo "FAIL: #[default] emitted"; fail=1; else echo "ok: no #[default] with agora markers"; fi

rm -f "$out_file"
exit $fail
