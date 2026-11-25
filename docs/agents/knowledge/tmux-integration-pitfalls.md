# tmux integration pitfalls (plugin development)

> Project knowledge for tmux-opencode-sessions. Captured 2026-11-24 during review round 1.

## `#{E:@option}` is the only way to ship a `#(...)` format fragment

- tmux 3.4 verified: a user option holding `#(cmd #{window_id})` renders via
  `#{E:@opencode_window_sessions}` — nested `#{window_id}` expands and the shell
  command runs — **but only when a real client is attached**. (Captured under
  the old per-pane names `@opencode_pane_sessions`/`#{pane_id}`; the shipped
  mechanism is now per-window.)
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

## Agora idle markers are an idle-only overlay, never a base state

- `plugins/tui.js` keeps two maps: `states` (event-driven base machine
  R/I/D/Q) and `agoraMarks` (board-derived). The transform happens only in
  `publishedState()` at write time: base "idle" renders the session's agora
  mark, every other base state passes through. Events therefore never see
  agora values, and a stale board reply cannot overwrite R/D/Q.
- Board polling is single-flight (`agoraInflight`) with a `stopped` recheck
  after the await, so a response racing cleanup cannot republish removed
  tmux keys — `write()` guards, but the poll drops the marks first.
- Classification precedence lives in one place (`classifyAgora`): "blocked"
  always wins over active; terminal states (merged/closed/cancelled) and
  malformed rows are ignored, not errors — any read failure degrades to
  plain idle.

## Shared fake-tmux log: stale values satisfy waits across tests

- Every plugin instance in one test process shares the same
  `TMUX_OPENCODE_TUI_<pid>_*` keys AND the same FAKE_TMUX_LOG, and
  `t.after` cleanups flush their unsets asynchronously. A wait like
  `lastValue(STATES) !== undefined` or `requests.length > 0` is therefore
  satisfied instantly by the PREVIOUS test's tail — the body then races the
  current instance's still-flushing initial publish (observed as a false
  "republish after cleanup": 9→12 write count, interleaved set/unset lines
  from two chains).
- Rule: before counting log lines mid-test, start from `fresh()` and gate
  on values only the current instance can produce (its own request count
  delta, its exact STATES string); after cleanup, let every queued chain
  settle (~250ms) and assert the log grows by ZERO lines, not just "no new
  -g writes".

代码指纹: publishedState, plugins/tui.js
代码指纹: classifyAgora, plugins/tui.js
代码指纹: pollAgora, plugins/tui.js
代码指纹: board, tests/helpers/context-stub.mjs
代码指纹: seeStates, tests/tui/agora.test.mjs

## House patterns reused here

- Atomic config writes: sibling temp file + `rename` (see install.sh;
  same pattern as tmux-agent-indicator's bindings file).
- Plugin rule: never `console.*` from OpenCode plugins — it pollutes the TUI
  (TTY-direct). Fire-and-forget child failures stay silent by design.
