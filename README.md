# tmux-opencode-sessions

A standalone OpenCode TUI plugin that appends per-window OpenCode session
status to the tmux window status line. Each OpenCode TUI publishes the state
of every session it shows; windows without OpenCode sessions keep their
normal status entries, byte for byte.

```
0:python3                                ← unchanged (no OpenCode in this window)
1:opencode* [R I]                        ← one running, one idle session
2:opencode [D Q Q]                       ← one done, two waiting for answers
```

## Letters and colors

| Letter | State | Color |
|--------|--------------------------|-------------------------|
| `R` | running | blue |
| `I` | idle | default (no color markup) |
| `D` | done | red |
| `Q` | waiting-for-answer (needs input) | yellow |

Every colored letter is closed with `#[fg=default]` (never `#[default]`).
Viewing a done tab changes only that session `D → I`; running and waiting
states are unaffected.

**Empty output rule:** a window with no OpenCode sessions renders zero
bytes — no brackets, no trailing space — so default window entries stay
untouched. A window with several OpenCode panes renders one bracket group
per pane, in pane-index order: `1:opencode [R I] [D Q]`.

## How it works

- `plugins/tui.js` (OpenCode TUI plugin) tracks the sessions of the TUI it
  runs in — tab order when tabs are enabled, otherwise the router's current
  session — and writes three keys to the tmux **global** environment:
  `TMUX_OPENCODE_TUI_<pid>_PANE`, `..._SESSIONS`, `..._STATES`. Writes are
  change-gated, serialized, refreshed immediately on events, reconciled at
  least once per second for tab open/close, and all three keys are removed
  on cleanup. Without `TMUX_PANE` the plugin does nothing.
- `scripts/window-sessions.sh <window_id>` renders the letters for one
  window from those keys — one bracket group per pane that hosts live
  OpenCode sessions — skipping dead TUI pids and foreign windows.
- `opencode-sessions.tmux` registers the `#{E:@opencode_window_sessions}`
  format fragment. It never touches `status-right` or `tmux.conf`, and it
  removes the old `@opencode_pane_sessions` registration when sourced.

## Install

Requirements: OpenCode v2, Node.js, tmux ≥ 3.3.

```sh
git clone <this repository> && cd tmux-opencode-sessions
./install.sh            # register this repo in ~/.config/opencode/cli.json
```

Then tell tmux where to render the status (your own window-status formats —
the plugin never changes options for you):

```tmux
set -g window-status-format '#I:#W#{E:@opencode_window_sessions}'
set -g window-status-current-format '#I:#W*#{E:@opencode_window_sessions}'
```

The exact surrounding style (`#I:#W`, the `*` marker, colors) is yours; the
fragment appends the state letters only when that window has sessions.

`install.sh` is idempotent, preserves every other `cli.json` setting, and
respects `XDG_CONFIG_HOME`. Restart your OpenCode TUI afterwards.

### TPM usage

If you manage tmux plugins with TPM, add the repository (it must be
reachable as a git remote for TPM):

```tmux
set -g @plugin '<git-url-of-this-repository>'
```

TPM sources `opencode-sessions.tmux`, which registers the format fragment.
The OpenCode side still needs `./install.sh` once (TPM does not edit
`cli.json`).

## Uninstall

```sh
./install.sh --uninstall   # removes only this repo's cli.json entry
```

Remove the `#{E:@opencode_window_sessions}` snippet from your
`window-status-format`, and press `prefix + I`/`prefix + U` if using TPM.

## Tests

```sh
bash tests/run-all.sh
```

See `AGENTS.md` for the repository layout and per-suite commands.
