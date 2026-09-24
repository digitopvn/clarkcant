#!/bin/sh
# ClarkCant installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/digitopvn/clarkcant/main/tools/install.sh | sh
#   sh tools/install.sh [setup options]        # from a checkout
#
# It checks for git and Node.js 22.19+, clones the repository when run outside one, enables pnpm through
# Corepack and hands over to the interactive onboarding (tools/setup.mjs). It never installs Node or
# Docker itself: that needs your package manager and your judgement, so it tells you how instead.
#
# CLARKCANT_DIR   where to clone (default: ./clarkcant)
# CLARKCANT_REF   branch or tag to check out (default: main)
set -eu

REPO_URL="${CLARKCANT_REPO:-https://github.com/digitopvn/clarkcant.git}"
TARGET="${CLARKCANT_DIR:-clarkcant}"
REF="${CLARKCANT_REF:-main}"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

node_hint() {
  case "$(uname -s)" in
    Darwin) say "  brew install node@24        (or https://nodejs.org, or fnm/nvm)" ;;
    Linux)  say "  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24"
            say "  (or your distribution's Node 24 package, or https://nodejs.org)" ;;
    *)      say "  https://nodejs.org" ;;
  esac
}

command -v node >/dev/null 2>&1 || { say "Node.js 22.19+ is required and was not found. Install it with:"; node_hint; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || { say "Node.js $(node --version) is too old; 22.19+ is required (24 recommended):"; node_hint; exit 1; }

# Inside a checkout already? Use it rather than cloning a second copy.
if [ -f tools/setup.mjs ] && [ -f pnpm-workspace.yaml ]; then
  ROOT="$(pwd)"
else
  command -v git >/dev/null 2>&1 || fail "git is required to download ClarkCant."
  if [ -d "$TARGET/.git" ]; then
    say "Using the existing checkout in $TARGET (not pulling; update it yourself with git pull)."
  else
    say "Cloning $REPO_URL ($REF) into $TARGET ..."
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET"
  fi
  ROOT="$(cd "$TARGET" && pwd)"
fi
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  say "Enabling pnpm through Corepack ..."
  corepack enable 2>/dev/null || sudo corepack enable \
    || fail "corepack enable failed. Run it yourself (it may need sudo), then re-run this script."
fi

# A piped installer has no terminal on stdin; give the onboarding the real one.
if [ -t 0 ]; then
  exec node tools/setup.mjs "$@"
elif [ -r /dev/tty ]; then
  exec node tools/setup.mjs "$@" </dev/tty
else
  exec node tools/setup.mjs --yes "$@"
fi
