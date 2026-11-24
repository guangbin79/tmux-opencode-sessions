#!/usr/bin/env bash
# End-to-end tmux format test: opencode-sessions.tmux registers the
# #{E:@opencode_pane_sessions} interpolation; a real attached client
# renders the status letters in the pane border label.
set -uo pipefail
cd "$(dirname "$0")/../.."
sock="oc-ft-$$"
fail=0
tmux -L "$sock" -f /dev/null new-session -d -x 120 -y 8
trap 'TMUX= tmux -L "$sock" kill-server 2>/dev/null' EXIT
pane=$(TMUX= tmux -L "$sock" display-message -p '#{pane_id}')

# Register this TUI's pane with a running and an idle session (live pid = $$).
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_PANE" "$pane"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_SESSIONS" "ses_a ses_b"
TMUX= tmux -L "$sock" set-environment -g "TMUX_OPENCODE_TUI_$$_STATES" "running idle"

# Load the plugin's tmux integration (must not touch status-right).
before_right=$(TMUX= tmux -L "$sock" show-options -gv status-right)
TMUX= tmux -L "$sock" set -g status-right "KEEP-ME"
export TMUX="/tmp/tmux-$(id -u)/$sock,99999,0"
bash opencode-sessions.tmux
after_right=$(TMUX= tmux -L "$sock" show-options -gv status-right)
if [ "$after_right" = "KEEP-ME" ]; then echo "ok: status-right untouched"; else echo "FAIL: status-right changed: [$after_right]"; fail=1; fi

# The user option must point at the renderer with the pane_id placeholder.
opt=$(TMUX= tmux -L "$sock" show-options -gv @opencode_pane_sessions)
case $opt in
  *"scripts/pane-sessions.sh #{pane_id}"*) echo "ok: @opencode_pane_sessions registered" ;;
  *) echo "FAIL: bad @opencode_pane_sessions: [$opt]"; fail=1 ;;
esac

# Attach a real client under a pty and check the border renders [R I].
TMUX= tmux -L "$sock" set -g pane-border-status top
TMUX= tmux -L "$sock" set -g pane-border-format ' #{pane_index} #{pane_title}#{E:@opencode_pane_sessions}'
TMUX= tmux -L "$sock" set -g status-interval 1
pty_out=$(mktemp /tmp/opencode/pty.XXXXXX)
(script -qec "timeout 4 tmux -L '$sock' attach" "$pty_out" >/dev/null 2>&1; true) &
seen=0
for _ in $(seq 1 60); do
  sleep 0.1
  # strip ANSI/CSI escapes, then look for the literal border rendering
  if sed $'s/\x1b\\[[0-9;?]*[a-zA-Z]//g; s/\x1b[()][0-9A-B]//g' "$pty_out" | grep -qF '[R I]'; then
    seen=1
    break
  fi
done
if [ "$seen" = 1 ]; then echo "ok: border label renders [R I] via attached client"; else echo "FAIL: [R I] never rendered in border"; fail=1; fi
wait 2>/dev/null
rm -f "$pty_out"
exit $fail
