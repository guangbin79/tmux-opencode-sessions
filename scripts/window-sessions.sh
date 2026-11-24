#!/usr/bin/env bash
# Render OpenCode session status letters for one tmux window's status line.
# Usage: window-sessions.sh <window_id>
# Output: " [R I] [D Q]"-style — one bracket group per pane that hosts live
# OpenCode sessions, in pane_index order (zero bytes when the window has
# no OpenCode sessions). Letters: R=running (blue), I=idle (default color),
# D=done (red), Q=needs-input (yellow). Reads
# TMUX_OPENCODE_TUI_<pid>_{PANE,SESSIONS,STATES} from the tmux global
# environment (written by plugins/tui.js) and skips dead TUI pids.
set -u
window=${1:-}
[ -n "$window" ] || exit 0

env_all=$(tmux show-environment -g 2>/dev/null) || exit 0

# Panes of this window as "pane_id pane_index", ascending numeric index.
panes=$(tmux list-panes -t "$window" -F '#{pane_id} #{pane_index}' 2>/dev/null | sort -k2,2n)
[ -n "$panes" ] || exit 0

groups=()
while read -r pane _idx; do
  [ -n "$pane" ] || continue
  # Live TUI pids registered for this pane, ascending (stable multi-TUI order).
  pids=$(printf '%s\n' "$env_all" | sed -n "s/^TMUX_OPENCODE_TUI_\\([0-9][0-9]*\\)_PANE=$pane\$/\\1/p" | sort -n)
  [ -n "$pids" ] || continue
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
  [ ${#letters[@]} -gt 0 ] || continue
  groups+=("${letters[*]}")
done <<<"$panes"

# printf reuses the format per group: " [R I] [D Q]" — one leading space,
# one space between groups, no trailing newline or space.
[ ${#groups[@]} -gt 0 ] || exit 0
printf ' [%s]' "${groups[@]}"
