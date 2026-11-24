#!/usr/bin/env bash
# Register/unregister this repository as an OpenCode TUI plugin by editing
# cli.json's "plugins" array (absolute path entry).
#   ./install.sh              add this repo to the plugins list (idempotent)
#   ./install.sh --uninstall  remove only this repo's entry
# Never touches tmux.conf, TPM, or any other cli.json setting. JSON
# handling is delegated to node so every existing setting round-trips
# safely; a malformed or unexpected cli.json (including a non-array
# "plugins") aborts without rewriting the file, and the final write is
# atomic (temp file + rename) so a crash can't truncate the config.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode=install
if [ "$#" -eq 1 ] && [ "$1" = "--uninstall" ]; then
  mode=uninstall
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--uninstall]" >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "install.sh: node is required (see README)" >&2; exit 1; }
cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
cfg="$cfg_dir/cli.json"

status=0
node - "$cfg" "$repo_dir" "$mode" <<'EOF' || status=$?
const fs = require("fs");
const path = require("path");
const [cfg, repo, mode] = process.argv.slice(2);

const refuse = (why) => {
  console.error(`install.sh: ${why}; refusing to edit ${cfg}`);
  process.exit(1);
};

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
    refuse(`${cfg} is not valid JSON`);
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    refuse(`${cfg} has an unexpected top-level shape`);
  }
}
if (settings.plugins !== undefined && !Array.isArray(settings.plugins)) {
  refuse(`${cfg} has a "plugins" field that is not an array`);
}
if (settings.plugins === undefined) settings.plugins = [];
const present = settings.plugins.includes(repo);

if (mode === "install") {
  if (present) process.exit(0); // idempotent: no rewrite
  settings.plugins.push(repo);
} else if (present) {
  settings.plugins = settings.plugins.filter((entry) => entry !== repo);
} else {
  process.exit(0); // nothing of ours to remove: no rewrite
}
fs.mkdirSync(path.dirname(cfg), { recursive: true });
// Atomic publish: write a sibling temp file, then rename over the config.
const tmp = `${cfg}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
fs.renameSync(tmp, cfg);
EOF
exit $status
