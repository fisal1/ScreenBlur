#!/usr/bin/env bash
#
# Build the ScreenBlur sidecar as a single executable.
#
# Usage:
#   ./scripts/build-engine.sh
#   PYTHON=/path/to/python ./scripts/build-engine.sh
#
# The resulting binary is engine/dist/screenblur-engine. If engine/models
# contains an .onnx model it is bundled into the one-file executable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3 || true)"
fi
if [[ -z "${PYTHON:-}" || ! -x "$PYTHON" ]]; then
  echo "error: no Python interpreter found (set PYTHON=...)" >&2
  exit 1
fi

if ! "$PYTHON" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "error: PyInstaller is not installed for $PYTHON" >&2
  echo "       install it with: $PYTHON -m pip install pyinstaller" >&2
  exit 1
fi

DATA_SEPARATOR=":"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DATA_SEPARATOR=";" ;;
esac

ARGS=(
  --noconfirm
  --clean
  --onefile
  --name screenblur-engine
  --paths "$ROOT"
  --distpath "$ROOT/dist"
  --workpath "$ROOT/build"
  --specpath "$ROOT/build"
  --collect-submodules app
  --collect-submodules uvicorn
  --collect-submodules websockets
  --hidden-import uvicorn.logging
  --hidden-import uvicorn.loops.auto
  --hidden-import uvicorn.protocols.http.auto
  --hidden-import uvicorn.protocols.websockets.auto
)

if [[ -d "$ROOT/models" ]]; then
  ARGS+=(--add-data "$ROOT/models${DATA_SEPARATOR}models")
fi

# onnxruntime is optional and imported lazily, so PyInstaller's static
# analysis cannot see it. Include it only when it is installed in this env.
if "$PYTHON" -c "import onnxruntime" >/dev/null 2>&1; then
  ARGS+=(--collect-all onnxruntime)
fi

"$PYTHON" -m PyInstaller "${ARGS[@]}" "$ROOT/run_engine.py"

chmod +x "$ROOT/dist/screenblur-engine"
echo "Built $ROOT/dist/screenblur-engine"
