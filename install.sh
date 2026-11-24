#!/usr/bin/env bash
# Register/unregister this repository as an OpenCode TUI plugin by editing
# cli.json's "plugins" array (absolute path entry).
#   ./install.sh              add this repo to the plugins list (idempotent)
#   ./install.sh --uninstall  remove only this repo's entry
# Never touches tmux.conf, TPM, or any other cli.json setting. JSON
# handling is delegated to node so every existing setting round-trips
# safely; a malformed cli.json aborts without rewriting the file.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=install
if [ "${1:-}" = "--uninstall" ]; then
  mode=uninstall
elif [ $# -gt 0 ]; then
  echo "usage: $0 [--uninstall]" >&2
  exit 2
fi
cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
cfg="$cfg_dir/cli.json"

status=0
node - "$cfg" "$repo_dir" "$mode" <<'EOF' || status=$?
const fs = require("fs");
const [cfg, repo, mode] = process.argv.slice(2);

let raw = null;
try {
  raw = fs.readFileSync(cfg, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let settings = {};
if (raw !== null) {
  if (raw.trim() === "") raw = "{}"; // empty file behaves like no config
  try {
    settings = JSON.parse(raw);
  } catch {
    console.error(`install.sh: ${cfg} is not valid JSON; refusing to edit it`);
    process.exit(1);
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    console.error(`install.sh: ${cfg} has an unexpected top-level shape; refusing to edit it`);
    process.exit(1);
  }
}
if (!Array.isArray(settings.plugins)) settings.plugins = [];
const present = settings.plugins.includes(repo);

if (mode === "install") {
  if (present) process.exit(0); // idempotent: no rewrite
  settings.plugins.push(repo);
} else if (present) {
  settings.plugins = settings.plugins.filter((entry) => entry !== repo);
} else {
  process.exit(0); // nothing of ours to remove: no rewrite
}
fs.mkdirSync(require("path").dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify(settings, null, 2) + "\n");
EOF
exit $status
