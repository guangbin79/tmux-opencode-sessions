#!/usr/bin/env bash
# tmux integration for tmux-opencode-sessions (sourced by TPM, or manually:
#   tmux source-file opencode-sessions.tmux).
# Registers the #{E:@opencode_window_sessions} format fragment that appends
# per-window OpenCode session status to the bottom window status line:
#   set -g window-status-format '#I:#W#{E:@opencode_window_sessions}'
#   set -g window-status-current-format '#I:#W*#{E:@opencode_window_sessions}'
# Touches only this user option — never status-right, never tmux.conf.
plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
tmux set -gq @opencode_window_sessions "#(${plugin_dir}/scripts/window-sessions.sh #{window_id})"
# Clean up the pre-window-renderer registration (pane border labels).
tmux set -gqu @opencode_pane_sessions
