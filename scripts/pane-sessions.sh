#!/usr/bin/env bash
# Render OpenCode session status letters for one tmux pane border label.
# Usage: pane-sessions.sh <pane_id>
# Output: " [R I]"-style (one leading space, no trailing newline), or zero
# bytes when the pane hosts no OpenCode sessions. Letters: R=running (blue),
# I=idle (default color), D=done (red), Q=needs-input (yellow).
# Reads TMUX_OPENCODE_TUI_<pid>_{PANE,SESSIONS,STATES} from the tmux global
# environment (written by plugins/tui.js) and skips dead TUI pids.
set -u
pane=${1:-}
[ -n "$pane" ] || exit 0

env_all=$(tmux show-environment -g 2>/dev/null) || exit 0

# Live TUI pids registered for this pane, ascending (stable multi-TUI order).
pids=$(printf '%s\n' "$env_all" | sed -n "s/^TMUX_OPENCODE_TUI_\\([0-9][0-9]*\\)_PANE=$pane\$/\\1/p" | sort -n)
[ -n "$pids" ] || exit 0

letters=()
for pid in $pids; do
  kill -0 "$pid" 2>/dev/null || continue # stale registration from a dead TUI
  sessions=$(printf '%s\n' "$env_all" | sed -n "s/^TMUX_OPENCODE_TUI_${pid}_SESSIONS=//p" | tail -n 1)
  states=$(printf '%s\n' "$env_all" | sed -n "s/^TMUX_OPENCODE_TUI_${pid}_STATES=//p" | tail -n 1)
  read -r -a sids <<<"$sessions"
  read -r -a sts <<<"$states"
  # STATES aligns element-for-element with SESSIONS; an invalid session id
  # drops its pair, an invalid or missing state renders as idle.
  for ((i = 0; i < ${#sids[@]}; i++)); do
    sid=${sids[i]}
    case $sid in '' | *[!A-Za-z0-9_-]*) continue ;; esac
    case ${sts[i]:-} in
      running) letters+=('#[fg=blue]R#[fg=default]') ;;
      done) letters+=('#[fg=red]D#[fg=default]') ;;
      needs-input) letters+=('#[fg=yellow]Q#[fg=default]') ;;
      *) letters+=('I') ;;
    esac
  done
done
[ ${#letters[@]} -gt 0 ] || exit 0
printf ' [%s]' "${letters[*]}"
