#!/usr/bin/env bash
# End-to-end tmux format test: opencode-sessions.tmux registers the
# #{E:@opencode_window_sessions} interpolation; a real attached client
# renders the status letters in the bottom window status line.
set -uo pipefail
cd "$(dirname "$0")/../.."
sock="oc-ft-$$"
fail=0
tmux -L "$sock" -f /dev/null new-session -d -x 120 -y 8
trap 'TMUX= tmux -L "$sock" kill-server 2>/dev/null' EXIT
pane=$(TMUX= tmux -L "$sock" display-message -p '#{pane_id}')
TMUX= tmux -L "$sock" rename-window opencode
TMUX= tmux -L "$sock" set -w automatic-rename off

# Register this TUI's pane with a running and an idle session (live pid = $$).
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_PANE" "$pane"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_STATES" "running idle"

# Simulate an upgrade from the pane-border version: stale option present.
TMUX= tmux -L "$sock" set -g @opencode_pane_sessions "stale"

# Load the plugin's tmux integration (must not touch status-right).
TMUX= tmux -L "$sock" set -g status-right "KEEP-ME"
export TMUX="/tmp/tmux-$(id -u)/$sock,99999,0"
bash opencode-sessions.tmux
after_right=$(TMUX= tmux -L "$sock" show-options -gv status-right)
if [ "$after_right" = "KEEP-ME" ]; then echo "ok: status-right untouched"; else echo "FAIL: status-right changed: [$after_right]"; fail=1; fi

# The user option must point at the renderer with the window_id placeholder.
opt=$(TMUX= tmux -L "$sock" show-options -gv @opencode_window_sessions)
case $opt in
  *"scripts/window-sessions.sh #{window_id}"*) echo "ok: @opencode_window_sessions registered" ;;
  *) echo "FAIL: bad @opencode_window_sessions: [$opt]"; fail=1 ;;
esac

# The stale pane registration must be gone after the upgrade.
stale=$(TMUX= tmux -L "$sock" show-options -gv @opencode_pane_sessions 2>/dev/null; true)
if [ -n "$stale" ]; then echo "FAIL: @opencode_pane_sessions still set: [$stale]"; fail=1; else echo "ok: stale @opencode_pane_sessions removed"; fi

# Attach a real client under a pty and check the status line renders [R I].
TMUX= tmux -L "$sock" set -g window-status-format '#I:#W#{E:@opencode_window_sessions}'
TMUX= tmux -L "$sock" set -g window-status-current-format '#I:#W*#{E:@opencode_window_sessions}'
TMUX= tmux -L "$sock" set -g status-interval 1
pty_out=$(mktemp /tmp/opencode/pty.XXXXXX)
(script -qec "timeout 4 tmux -L '$sock' attach" "$pty_out" >/dev/null 2>&1; true) &
seen=0
for _ in $(seq 1 60); do
  sleep 0.1
  # strip ANSI/CSI escapes, then look for the literal window status rendering
  if sed $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g; s/\x1b[()][0-9A-B]//g' "$pty_out" | grep -qF '0:opencode* [R I]'; then
    seen=1
    break
  fi
done
if [ "$seen" = 1 ]; then echo "ok: window status renders 0:opencode* [R I] via attached client"; else echo "FAIL: [R I] never rendered in window status"; fail=1; fi
wait 2>/dev/null
rm -f "$pty_out"
exit $fail
