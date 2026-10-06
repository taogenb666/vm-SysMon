#!/usr/bin/env bash
# Install SysMon on this host: virtualenv, dependencies, systemd unit.
#
#   ./install.sh                set up .venv, install and start the service
#   ./install.sh --no-service   only create .venv and install dependencies
#   ./install.sh --port 8080    listen on another port
#   ./install.sh --uninstall    stop and remove the systemd unit
#
# The systemd unit is generated from deploy/sysmon.service with __PROJECT_DIR__
# and __PORT__ replaced, so the project can live anywhere.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="sysmon"
PORT=""
PYTHON=""
WITH_SERVICE=1
UNINSTALL=0

while [ "$#" -ge 1 ]; do
  case "$1" in
    --no-service) WITH_SERVICE=0 ;;
    --uninstall)  UNINSTALL=1 ;;
    --port)
      shift
      PORT=""
      if [ "$#" -ge 1 ]; then PORT="$1"; fi
      ;;
    --python)
      shift
      PYTHON=""
      if [ "$#" -ge 1 ]; then PYTHON="$1"; fi
      ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$PYTHON" ]; then PYTHON=python3; fi
if [ -z "$PORT" ]; then PORT=8000; fi

echo "project : $PROJECT_DIR"
echo "python  : $PYTHON"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "removing the systemd unit needs root: re-run with sudo"
    exit 1
  fi
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload || true
  echo "removed $SERVICE_NAME.service (project files and sysmon/data are untouched)"
  exit 0
fi

"$PYTHON" - <<'PYCHECK' || { echo "error: SysMon needs Python 3.10 or newer"; exit 1; }
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PYCHECK

if [ ! -d "$PROJECT_DIR/.venv" ]; then
  echo "creating virtualenv ..."
  "$PYTHON" -m venv "$PROJECT_DIR/.venv"
fi

echo "installing dependencies ..."
"$PROJECT_DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
"$PROJECT_DIR/.venv/bin/python" -m pip install --quiet -r "$PROJECT_DIR/requirements.txt"

if [ "$WITH_SERVICE" -eq 0 ]; then
  echo
  echo "done. start it manually with:"
  echo "  cd $PROJECT_DIR && .venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo
  echo "the virtualenv is ready, but installing the systemd unit needs root."
  echo "re-run with: sudo $0"
  exit 1
fi

TEMPLATE="$PROJECT_DIR/deploy/sysmon.service"
TARGET="/etc/systemd/system/$SERVICE_NAME.service"
if [ ! -f "$TEMPLATE" ]; then
  echo "error: missing unit template $TEMPLATE"
  exit 1
fi

echo "writing $TARGET (port $PORT) ..."
sed -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" -e "s#__PORT__#$PORT#g" "$TEMPLATE" > "$TARGET"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo
  echo "SysMon is running."
  echo "  local : http://127.0.0.1:$PORT/"
  ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$ADDRESS" ]; then echo "  LAN   : http://$ADDRESS:$PORT/"; fi
  echo "  logs  : journalctl -u $SERVICE_NAME -f"
else
  echo "service did not start, check: journalctl -u $SERVICE_NAME -n 50 --no-pager"
  exit 1
fi
