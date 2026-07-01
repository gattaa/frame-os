#!/usr/bin/env bash
# Re-copy canonical service source into each HAOS add-on's src/ folder.
#
# pipeline/ and uploader/ remain the single source of truth for the actual
# service code (per ../CLAUDE.md's architecture contract, nothing here changes
# what they do — only how their paths/config are supplied). This script keeps
# each add-on's src/ in sync with that canonical code. Re-run it any time you
# edit pipeline/processor.py or uploader/app.py.
#
# NOT synced (maintained by hand, per add-on, in this folder):
#   - each add-on's own requirements.txt (Alpine/musl-appropriate pins, may
#     differ from the canonical requirements.txt — e.g. the add-on drops
#     uvicorn's [standard] extra to avoid an Alpine wheel-availability risk;
#     see frame-uploader/DOCS.md)
#   - config.yaml, build.yaml, Dockerfile, run.sh, DOCS.md
#
# After syncing, bump the `version` in the affected add-on's config.yaml to
# make the Supervisor rebuild it (Supervisor only rebuilds on a version bump).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADDONS="$ROOT/haos-addons"

sync_file() {
  local canonical_dir="$1" addon_dir="$2" filename="$3"
  local src="$ROOT/$canonical_dir/$filename"
  local dst="$ADDONS/$addon_dir/src/$filename"
  if [ ! -f "$src" ]; then
    echo "ERROR: $src does not exist" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "synced $canonical_dir/$filename -> haos-addons/$addon_dir/src/$filename"
}

sync_file pipeline frame-pipeline processor.py
sync_file uploader  frame-uploader app.py

echo ""
echo "Done. If any synced file changed, bump 'version' in that add-on's"
echo "config.yaml so the Supervisor rebuilds it on the next Store reload."
