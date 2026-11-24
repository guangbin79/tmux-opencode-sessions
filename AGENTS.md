# AGENTS.md

## Commands

- Full suite (also the acceptance gate): `bash tests/run-all.sh`
- TUI state machine only: `FAKE_TMUX_LOG=$(mktemp /tmp/opencode/t.XXXX) PATH="$PWD/tests/helpers:$PATH" node tests/tui/states.test.mjs` (same for `lifecycle.test.mjs`)
- Renderer bytes: `bash tests/renderer/render.sh` — spins an isolated tmux server
- End-to-end border rendering: `bash tests/renderer/format.sh`
- Installer: `bash tests/installer/test.sh`
- Syntax: `node -e "import('./plugins/tui.js')"` and `bash -n` on the shell scripts

## Layout

- `plugins/tui.js` — OpenCode TUI plugin; publishes
  `TMUX_OPENCODE_TUI_<pid>_{PANE,SESSIONS,STATES}` to the tmux global env
- `scripts/pane-sessions.sh` — renderer; ` <pane_id>` → ` [R I]`-style bytes
- `opencode-sessions.tmux` — tmux/TPM entry; registers
  `#{E:@opencode_pane_sessions}` (touches nothing else)
- `install.sh` — idempotent `cli.json` plugin registration; `--uninstall`
- `tests/helpers/tmux` — fake tmux binary (records calls; shadows real tmux
  **only** for the TUI node runs, see run-all.sh)
- `tests/tui/`, `tests/renderer/`, `tests/installer/` — suites

## Binding contracts

- Letter/color mapping: R=running blue, I=idle default, D=done red,
  Q=needs-input yellow; colored letters end with `#[fg=default]`, never
  `#[default]`; no sessions ⇒ zero bytes of pane output.
- `STATES` aligns element-for-element with `SESSIONS` (tab order).
- Never modify `status-right`, `tmux.conf`, TPM, or files outside this repo.
