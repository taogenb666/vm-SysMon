#!/usr/bin/env bash
# Start SysMon: creates a virtualenv on first run, installs deps, launches uvicorn.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="$PYTHON_BIN"
[ -n "$PYTHON" ] || PYTHON=python3

HOST="$SYSMON_HOST"
[ -n "$HOST" ] || HOST=0.0.0.0
PORT="$SYSMON_PORT"
[ -n "$PORT" ] || PORT=8000

if [ ! -d .venv ]; then
  echo "[run.sh] creating virtualenv"
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

echo "[run.sh] SysMon listening on http://$HOST:$PORT"
exec python -m uvicorn app.main:app --host "$HOST" --port "$PORT"
