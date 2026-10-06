#!/usr/bin/env bash
# kineReqLens installer for macOS and Linux (Windows: install.ps1). From the root of a clone:
#
#   ./install.sh [--yes] [--with-claude | --no-claude] [--browser edge|chrome|chromium|brave|all]
#                [--update] [--no-open] [--dry-run] [--help]
#
# This script makes sure Node.js >= 20 and npm are there (it prints how to install them, and offers Homebrew on macOS
# when run in a terminal), then hands over to scripts/installer.mjs, which installs the dependencies, builds the
# extension and the Claude Code bridge, sets the bridge up (optional) and shows how to load dist/ in the browser.
# Safe to run again. Never uses sudo. Details: INSTALL.md
set -euo pipefail

MIN_NODE_MAJOR=20
ROOT="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [ -t 1 ] && [ -z "${NO_COLOR+x}" ] && [ "${TERM:-}" != "dumb" ]; then
  BOLD=$'\033[1m' RED=$'\033[31m' CYAN=$'\033[36m' RESET=$'\033[0m'
else
  BOLD='' RED='' CYAN='' RESET=''
fi

err() { printf '%s\n' "${RED}${BOLD}$*${RESET}" >&2; }
hint() { printf '  %s\n' "$*" >&2; }

YES=0
for arg in "$@"; do
  case "$arg" in
    -y | -Y | --yes | --Yes | --YES | -yes | -Yes | -YES) YES=1 ;;
  esac
done

# Major version of the node on PATH (empty when there is none).
node_major() {
  command -v node >/dev/null 2>&1 || return 0
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

node_ready() {
  local major
  major="$(node_major)"
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1
}

# "<ID> <ID_LIKE>" from /etc/os-release (empty when unknown).
linux_ids() {
  [ -r /etc/os-release ] || return 0
  # shellcheck disable=SC1091
  (. /etc/os-release && printf '%s %s\n' "${ID:-}" "${ID_LIKE:-}") 2>/dev/null || true
}

explain_node() {
  local found=''
  if command -v node >/dev/null 2>&1; then found="$(node --version 2>/dev/null || true)"; fi
  if [ -z "$found" ]; then
    err "kineReqLens needs Node.js $MIN_NODE_MAJOR or newer and npm: Node.js was not found."
  elif ! command -v npm >/dev/null 2>&1; then
    err "kineReqLens needs npm, which was not found (Node.js $found is installed)."
  else
    err "kineReqLens needs Node.js $MIN_NODE_MAJOR or newer (found $found)."
  fi
  printf '%s\n' 'Install it, open a new terminal, then run ./install.sh again:' >&2
  case "$(uname -s)" in
    Darwin)
      hint 'Homebrew:  brew install node'
      hint 'nvm:       https://github.com/nvm-sh/nvm#installing-and-updating, then: nvm install --lts'
      hint 'Installer: https://nodejs.org/en/download'
      ;;
    Linux)
      hint 'nvm (any distribution, no sudo): https://github.com/nvm-sh/nvm#installing-and-updating, then: nvm install --lts'
      case " $(linux_ids) " in
        *' debian '* | *' ubuntu '*)
          hint 'Debian / Ubuntu (their own nodejs package is often older than 20), NodeSource:'
          hint '  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs'
          ;;
        *' fedora '* | *' rhel '* | *' centos '*) hint 'Fedora / RHEL:  sudo dnf install nodejs npm' ;;
        *' arch '*) hint 'Arch:  sudo pacman -S nodejs npm' ;;
        *' alpine '*) hint 'Alpine:  sudo apk add nodejs npm' ;;
        *) hint "Or your distribution's nodejs and npm packages (version $MIN_NODE_MAJOR or newer)" ;;
      esac
      ;;
    *)
      hint 'https://nodejs.org/en/download'
      ;;
  esac
}

if ! node_ready; then
  explain_node
  # Homebrew only after an explicit yes (never with --yes, never without a terminal).
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && [ "$YES" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
    printf '%s' "${CYAN}?${RESET} Install Node.js with Homebrew now (brew install node)? [y/N] "
    answer=''
    read -r answer || answer=''
    case "$answer" in
      y | Y | yes | Yes | YES)
        brew install node || {
          err 'brew install node failed.'
          exit 1
        }
        hash -r
        ;;
    esac
  fi
  node_ready || exit 1
fi

exec node "$ROOT/scripts/installer.mjs" install "$@"
