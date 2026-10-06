#!/usr/bin/env bash
# SysMon version helper - inspect history and roll the project back safely.
#
#   ./tools/rollback.sh list [n]       recent commits and tags
#   ./tools/rollback.sh diff <ref>     what changed between <ref> and now
#   ./tools/rollback.sh restore <ref>  roll the project back to <ref>
#   ./tools/rollback.sh undo --yes     discard uncommitted project changes
#
# The repository lives at the workspace root; the project is its sysmon/ subtree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel)"
SUBTREE="$(git -C "$PROJECT_DIR" rev-parse --show-prefix)"
# A repo cloned from GitHub has the project at its root, so the prefix is empty.
[ -n "$SUBTREE" ] || SUBTREE="."
SERVICE="$(printenv SYSMON_SERVICE 2>/dev/null || true)"
[ -n "$SERVICE" ] || SERVICE=sysmon

usage() {
  sed -n '2,10p' "$0"
  exit 1
}

dirty() {
  [ -n "$(git -C "$REPO_DIR" status --porcelain -- "$SUBTREE")" ]
}

command=list
if [ "$#" -ge 1 ]; then command="$1"; fi

case "$command" in
  list)
    count=15
    if [ "$#" -ge 2 ]; then count="$2"; fi
    echo "repo    : $REPO_DIR"
    echo "subtree : $SUBTREE"
    echo
    echo "recent commits:"
    git -C "$REPO_DIR" log --oneline -n "$count" -- "$SUBTREE" | sed 's/^/  /'
    echo
    echo "tags:"
    if [ -n "$(git -C "$REPO_DIR" tag -l)" ]; then
      git -C "$REPO_DIR" tag -l | sed 's/^/  /'
    else
      echo "  (none yet - create one with: git tag -a v1.0.0 -m 'first release')"
    fi
    ;;
  diff)
    if [ "$#" -lt 2 ]; then usage; fi
    git -C "$REPO_DIR" diff --stat "$2" -- "$SUBTREE"
    ;;
  restore)
    if [ "$#" -lt 2 ]; then usage; fi
    target="$2"
    if ! git -C "$REPO_DIR" rev-parse --verify --quiet "$target^{commit}" >/dev/null; then
      echo "error: unknown revision: $target"
      exit 1
    fi
    echo "target: $target ($(git -C "$REPO_DIR" log -1 --format=%h\ %s "$target"))"
    if dirty; then
      echo "uncommitted changes found - stashing them first"
      git -C "$REPO_DIR" -c user.name=sysmon-rollback -c user.email=rollback@localhost \
        stash push -m "sysmon backup before rollback to $target" -- "$SUBTREE"
    fi
    git -C "$REPO_DIR" checkout "$target" -- "$SUBTREE"
    if dirty; then
      git -C "$REPO_DIR" -c user.name=sysmon-rollback -c user.email=rollback@localhost \
        commit -q -m "Roll sysmon back to $target"
      echo "restored $SUBTREE to $target and committed the rollback"
    else
      echo "no file changes (already identical to $target)"
    fi
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      systemctl restart "$SERVICE"
      echo "restarted $SERVICE"
    fi
    ;;
  undo)
    if [ "$#" -lt 2 ] || [ "$2" != "--yes" ]; then
      echo "This discards uncommitted changes under $SUBTREE."
      echo "Re-run with: $0 undo --yes"
      exit 1
    fi
    git -C "$REPO_DIR" checkout -- "$SUBTREE"
    echo "discarded uncommitted project changes"
    ;;
  *)
    usage
    ;;
esac
