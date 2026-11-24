#!/usr/bin/env bash
# tmux integration for tmux-opencode-sessions (sourced by TPM, or manually:
#   tmux source-file opencode-sessions.tmux).
# Registers the #{E:@opencode_pane_sessions} format fragment that appends
# per-pane OpenCode session status to a pane-border-format or status line:
#   set -g pane-border-status top
#   set -g pane-border-format ' #{pane_index} #{pane_title}#{E:@opencode_pane_sessions}'
# Touches only this user option — never status-right, never tmux.conf.
plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
tmux set -gq @opencode_pane_sessions "#(${plugin_dir}/scripts/pane-sessions.sh #{pane_id})"
