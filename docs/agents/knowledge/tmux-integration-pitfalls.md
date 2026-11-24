# tmux integration pitfalls (plugin development)

> Project knowledge for tmux-opencode-sessions. Captured 2026-11-24 during review round 1.

## `#{E:@option}` is the only way to ship a `#(...)` format fragment

- tmux 3.4 verified: a user option holding `#(cmd #{pane_id})` renders via
  `#{E:@opencode_pane_sessions}` — nested `#{pane_id}` expands and the shell
  command runs — **but only when a real client is attached**.
- `tmux display-message -p` evaluates `#()` to empty on first use (async job
  table) and may stay empty without a client; never gate tests on
  `display-message` alone. Test end-to-end by attaching a client under a pty
  (`script -qec "timeout 4 tmux -L sock attach" out.log`) and grepping the
  drawn bytes after stripping ANSI/CSI escapes.
- First draw after an env change is empty for one refresh cycle; the TUI
  plugin compensates by calling `refresh-client` after every publish.

## Test doubles that shadow a real binary must carry its exact name

`tests/helpers/tmux` only shadows the real binary for the TUI node runs
(PATH-scoped in run-all.sh). Initial mistake: naming it `fake-tmux.sh` —
nothing named `tmux` was on PATH, so every `execFile("tmux")` hit the REAL
tmux server of the host session and polluted its global environment. Rule: a
PATH shadow must be named exactly like the binary, and suites that need the
real binary must not inherit the shadowed PATH.

## House patterns reused here

- Atomic config writes: sibling temp file + `rename` (see install.sh;
  same pattern as tmux-agent-indicator's bindings file).
- Plugin rule: never `console.*` from OpenCode plugins — it pollutes the TUI
  (TTY-direct). Fire-and-forget child failures stay silent by design.
