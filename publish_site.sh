#!/usr/bin/env bash
# Build the static edition and publish it to the gh-pages branch.
#
# GitHub Pages serves that branch at https://<owner>.github.io/bayan/. The
# build is committed as a single squashed commit on every run, so the branch
# history stays one publish per release rather than one per file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-gh-pages}"
VERSION="$(cat VERSION)"
PY="${PY:-$ROOT/.venv/bin/python}"

[ -x "$PY" ] || { echo "no interpreter at $PY — set PY=..." >&2; exit 1; }

echo "bayan $VERSION — building dist-site/"
"$PY" export_static.py

# A publish with stale bytes is worse than no publish: prove the payload.
[ -f dist-site/index.html ] || { echo "dist-site/index.html missing" >&2; exit 1; }
[ -f dist-site/static/site.js ] || { echo "dist-site/static/site.js missing" >&2; exit 1; }
[ -f dist-site/.nojekyll ] || { echo "dist-site/.nojekyll missing" >&2; exit 1; }
if find dist-site -name '*.db' -o -name '*.env' | grep -q .; then
  echo "refusing to publish: database or env file inside dist-site" >&2
  exit 1
fi

NAME="$(git -C "$ROOT" config user.name || true)"
EMAIL="$(git -C "$ROOT" config user.email || true)"
NAME="${NAME:-NxGenWidgeter}"
EMAIL="${EMAIL:-nxautomation003@gmail.com}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -a dist-site/. "$TMP"/
cd "$TMP"
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name="$NAME" -c user.email="$EMAIL" \
  commit -qm "Tawatur $VERSION — static edition"
git push -q --force "$(git -C "$ROOT" remote get-url "$REMOTE")" "$BRANCH"

echo "published $(find . -path ./.git -prune -o -type f -print | wc -l) files to $BRANCH"
