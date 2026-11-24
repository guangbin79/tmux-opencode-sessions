#!/usr/bin/env bash
# Installer tests: cli.json registration, preservation, idempotency,
# uninstall, XDG support, and the tmux/TPM no-touch boundary.
set -uo pipefail
cd "$(dirname "$0")/../.."
repo=$PWD
fail=0
check() { if [ "$1" = "0" ]; then echo "ok: $2"; else echo "FAIL: $2"; fail=1; fi; }

fresh_home() {
  TEST_HOME=$(mktemp -d /tmp/opencode/inst.XXXXXX)
  mkdir -p "$TEST_HOME/.config/opencode"
  cfg=$TEST_HOME/.config/opencode/cli.json
}
# first allocation so later helpers have valid paths
fresh_home

run_install() { # args...
  HOME=$TEST_HOME XDG_CONFIG_HOME=$TEST_HOME/.config bash "$repo/install.sh" "$@"
}
json() { HOME=$TEST_HOME XDG_CONFIG_HOME=$TEST_HOME/.config node -e "
  const fs = require('fs');
  try { const o = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        console.log(eval('('+process.argv[2]+')')); }
  catch (e) { console.log('PARSE_ERROR'); }" "$cfg" "$1"; }

# 1. no cli.json: creates it with exactly this repo path
fresh_home
run_install >/dev/null 2>&1
[ "$(json "JSON.stringify(o.plugins)")" = "[\"$repo\"]" ]; check $? "creates cli.json with repo path"
[ -e "$TEST_HOME/.tmux.conf" ] && { echo "FAIL: touched ~/.tmux.conf"; fail=1; }
[ -e "$TEST_HOME/.tmux" ] && { echo "FAIL: touched ~/.tmux (TPM)"; fail=1; }
echo "ok: no tmux.conf / TPM writes"

# 2. preserves unrelated settings and existing plugin entries
fresh_home
cat > "$cfg" <<'EOF'
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "theme": { "name": "nord" },
  "mouse": true,
  "plugins": ["opencode.some-other", "./local/thing"]
}
EOF
run_install >/dev/null 2>&1
[ "$(json "o['\$schema']")" = "https://opencode.ai/v2/cli.json" ]; check $? "preserves \$schema"
[ "$(json "o.theme.name")" = "nord" ]; check $? "preserves theme"
[ "$(json "o.mouse")" = "true" ]; check $? "preserves mouse"
[ "$(json "JSON.stringify(o.plugins)")" = "[\"opencode.some-other\",\"./local/thing\",\"$repo\"]" ]; check $? "appends own entry, keeps others"

# 3. idempotent: second run does not duplicate
run_install >/dev/null 2>&1
[ "$(json "o.plugins.filter(p => p === '$repo').length")" = "1" ]; check $? "idempotent: single own entry"
[ "$(json "JSON.stringify(o.plugins)")" = "[\"opencode.some-other\",\"./local/thing\",\"$repo\"]" ]; check $? "idempotent: list unchanged"

# 4. uninstall removes only its own entry
run_install --uninstall >/dev/null 2>&1
[ "$(json "JSON.stringify(o.plugins)")" = "[\"opencode.some-other\",\"./local/thing\"]" ]; check $? "uninstall removes only own entry"
[ "$(json "o.theme.name")" = "nord" ]; check $? "uninstall preserves settings"

# 5. uninstall with no own entry: file stays byte-identical
before=$(cat "$cfg")
run_install --uninstall >/dev/null 2>&1
[ "$(cat "$cfg")" = "$before" ]; check $? "uninstall no-op leaves file untouched"

# 6. malformed cli.json: install refuses and does not clobber
fresh_home
echo '{broken json' > "$cfg"
before=$(cat "$cfg")
run_install >/dev/null 2>&1 && { echo "FAIL: install succeeded on malformed config"; fail=1; } || echo "ok: malformed config rejected"
[ "$(cat "$cfg")" = "$before" ]; check $? "malformed config left byte-identical"

# 7. XDG_CONFIG_HOME respected (non-default location)
fresh_home
mkdir -p "$TEST_HOME/xdg"
HOME=$TEST_HOME XDG_CONFIG_HOME=$TEST_HOME/xdg bash "$repo/install.sh" >/dev/null 2>&1
[ "$(HOME=$TEST_HOME XDG_CONFIG_HOME=$TEST_HOME/xdg node -e "console.log(JSON.parse(require('fs').readFileSync('$TEST_HOME/xdg/opencode/cli.json','utf8')).plugins[0])")" = "$repo" ]; check $? "registers under XDG_CONFIG_HOME/opencode/cli.json"

rm -rf "$TEST_HOME"
exit $fail
