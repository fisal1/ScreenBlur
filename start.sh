#!/usr/bin/env bash
# macOS / Linux equivalent of start.ps1. Uses Node.js from PATH if installed, otherwise a
# portable copy in tools/node (downloaded on first run).
# Usage: ./start.sh            -> npm start
#        ./start.sh verbose    -> npm run verbose (logs every result)
#        ./start.sh selftest   -> npm run selftest
#        ./start.sh test       -> npm test
set -euo pipefail

NODE_VERSION="v24.22.1"
SCRIPT="${1:-start}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTABLE_NODE="$ROOT/tools/node"
cd "$ROOT"

install_portable_node() {
  local os arch name
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  name="node-$NODE_VERSION-$os-$arch"
  echo "Node.js not found. Downloading portable Node.js $NODE_VERSION..."
  mkdir -p "$ROOT/tools"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" | tar -xz -C "$ROOT/tools"
  mv "$ROOT/tools/$name" "$PORTABLE_NODE"
}

if [ -x "$PORTABLE_NODE/bin/node" ]; then
  export PATH="$PORTABLE_NODE/bin:$PATH"
elif ! command -v node > /dev/null 2>&1; then
  install_portable_node
  export PATH="$PORTABLE_NODE/bin:$PATH"
fi

[ -d node_modules ] || npm install
# npm may block dependency install scripts, so fetch the Electron binary and model explicitly.
[ -d node_modules/electron/dist ] || node node_modules/electron/install.js
[ -f models/320n.onnx ] || node scripts/fetch-model.js

case "$SCRIPT" in
  start | test) npm "$SCRIPT" ;;
  *) npm run "$SCRIPT" ;;
esac
