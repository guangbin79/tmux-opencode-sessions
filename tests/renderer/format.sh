#!/usr/bin/env bash
# End-to-end tmux format test: opencode-sessions.tmux registers the
# #{E:@opencode_window_sessions} interpolation; a real attached client
# renders the status letters in the bottom window status line.
set -uo pipefail
cd "$(dirname "$0")/../.."
sock="oc-ft-$$"
fail=0
# The attached-client check needs a terminal type with real capabilities;
# gate/CI drivers run with TERM unset or "dumb" — tmux attach then draws
# nothing and the steady-frame assertion sees an empty capture.
case "${TERM:-}" in '' | dumb) export TERM=xterm ;; esac
tmux -L "$sock" -f /dev/null new-session -d -x 120 -y 8 'sleep 30'
trap 'TMUX= tmux -L "$sock" kill-server 2>/dev/null' EXIT
# The server inherits the driver's exported environment; drop any live
# TMUX_OPENCODE_TUI_* registration so dynamic pane ids stay deterministic.
for key in $(TMUX= tmux -L "$sock" show-environment -g | sed -n 's/^\(TMUX_OPENCODE_TUI_[^=]*\)=.*/\1/p'); do
  TMUX= tmux -L "$sock" set-environment -gu "$key"
done
TMUX= tmux -L "$sock" rename-window opencode
TMUX= tmux -L "$sock" set -w automatic-rename off
# Second window in the same server: it takes the registrations, window 0
# must stay bare. Creating it without -d also makes it the current window.
# Plain `sleep` keeps both windows shell-free and deterministic.
wpane=$(TMUX= tmux -L "$sock" new-window -P -F '#{pane_id}' 'sleep 30')
TMUX= tmux -L "$sock" rename-window opencode
TMUX= tmux -L "$sock" set -w automatic-rename off

# Register this TUI's pane with a running, an idle, an agora and an
# agora-blocked session (live pid = $$).
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_PANE" "$wpane"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b ses_c ses_d"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_STATES" "running idle agora agora-blocked"

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

# Attach a real client under a pty and check the settled status frame. The
# async #() jobs start empty and fill per entry, so early frames are
# transient (either window may briefly show letters it must not); the LAST
# [0]-anchored, KEEP-ME-terminated segment of the stripped capture is the
# newest fully drawn frame — the steady screen. It must show BOTH windows:
# bare window 0 (no OpenCode sessions) beside the session-bearing current
# window 1. This guards the per-window #{window_id} expansion: a
# fixed/current-window registration bleeds [R I] into window 0's entry.
TMUX= tmux -L "$sock" set -g window-status-format '#I:#W#{E:@opencode_window_sessions}'
TMUX= tmux -L "$sock" set -g window-status-current-format '#I:#W*#{E:@opencode_window_sessions}'
TMUX= tmux -L "$sock" set -g window-status-separator ' '
TMUX= tmux -L "$sock" set -g status-interval 1
pty_out=$(mktemp /tmp/opencode/pty.XXXXXX)
(script -qec "timeout 4 tmux -L '$sock' attach" "$pty_out" >/dev/null 2>&1; true) &
seen=0
last_frame=''
for _ in $(seq 1 60); do
  sleep 0.1
  # strip ANSI/CSI escapes; the newest fully drawn frame is the last segment
  frame=$(sed $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g; s/\x1b[()][0-9A-B]//g' "$pty_out" | grep '\[0\] .*KEEP-ME' | tail -n 1)
  last_frame=${frame##*\[0\] }
  case $last_frame in
    '0:opencode 1:opencode* [R I A I*]'*KEEP-ME*) seen=1; break ;;
  esac
done
if [ "$seen" = 1 ]; then echo "ok: steady frame renders bare 0:opencode and 1:opencode* [R I A I*] via attached client"; else echo "FAIL: steady frame is [$last_frame]"; fail=1; fi
wait 2>/dev/null
rm -f "$pty_out"
exit $fail
