#!/usr/bin/env bash
# kineReqLens uninstaller for macOS and Linux (Windows: uninstall.ps1). From the root of the clone:
#
#   ./uninstall.sh [--yes] [--no-claude] [--browser edge|chrome|chromium|brave|all] [--dry-run] [--help]
#
# Removes the native messaging host (launcher + browser manifests) and, after asking, the "reqlens" MCP server from
# Claude Code (scripts/installer.mjs uninstall), then shows how to remove the extension from the browser. Never deletes
# this folder or $REQLENS_HOME. Without Node.js it removes the native messaging host files directly.
set -euo pipefail

MIN_NODE_MAJOR=20
ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

node_major() {
  command -v node >/dev/null 2>&1 || return 0
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

major="$(node_major)"
case "$major" in
  '' | *[!0-9]*) major=0 ;;
esac
if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
  exec node "$ROOT/scripts/installer.mjs" uninstall "$@"
fi

# Without Node.js 20+: remove what `reqlens-mcp install` wrote (every browser's manifest and the launcher).
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run | -DryRun | -dryrun | -WhatIf | -whatif) DRY=1 ;;
    -h | --help | -Help | -help)
      printf '%s\n' 'Usage: ./uninstall.sh [--yes] [--no-claude] [--browser <name>] [--dry-run]  (Node.js 20+ not found: files only)'
      exit 0
      ;;
  esac
done
printf '%s\n' 'Node.js 20+ not found: removing the native messaging host files directly.'

remove() {
  [ -e "$1" ] || return 0
  if [ "$DRY" -eq 1 ]; then
    printf '  would remove %s\n' "$1"
  else
    rm -f -- "$1" && printf '  Removed %s\n' "$1"
  fi
}

case "$(uname -s)" in
  Darwin)
    base="$HOME/Library/Application Support"
    set -- 'Microsoft Edge' 'Microsoft Edge Beta' 'Microsoft Edge Dev' 'Microsoft Edge Canary' 'Google/Chrome' \
      'Google/Chrome Beta' 'Google/Chrome Canary' 'Chromium' 'BraveSoftware/Brave-Browser'
    ;;
  *)
    base="${XDG_CONFIG_HOME:-$HOME/.config}"
    set -- 'microsoft-edge' 'microsoft-edge-beta' 'microsoft-edge-dev' 'google-chrome' 'google-chrome-beta' 'chromium' \
      'BraveSoftware/Brave-Browser'
    ;;
esac
for browser in "$@"; do
  remove "$base/$browser/NativeMessagingHosts/com.reqlens.bridge.json"
done
remove "${REQLENS_HOME:-$HOME/.reqlens}/native-host"

printf '%s\n' \
  'Claude Code: if you registered the MCP server, run:  claude mcp remove reqlens -s user' \
  'Browser: open edge://extensions (chrome://extensions, brave://extensions) -> kineReqLens -> Remove' \
  "Left in place: this folder ($ROOT) and ${REQLENS_HOME:-$HOME/.reqlens}."
