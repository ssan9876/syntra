#!/usr/bin/env bash
#
# Assemble a release tarball the way .github/workflows/release.yml does, from
# the checkout this is run in.
#
#   ./make-release.sh 1.0.1 /var/tmp/releases
#   ./make-release.sh 1.0.3 /var/tmp/releases 'sed -i ... apps/api/src/x.ts'
#
# The third argument is a shell snippet run with the assembled tree as its
# working directory, immediately before packing. That is how the rehearsal
# stages a release that fails -- which is the whole point of having one.
#
# The exclusions and the three tar assertions are the same as release.yml's,
# because a rehearsal against a differently-shaped artefact rehearses a
# different feature.
set -euo pipefail

VERSION="$1"
OUT="$2"
MUTATE="${3:-}"

cd "$(git rev-parse --show-toplevel)"
mkdir -p "$OUT"

STAGE=$(mktemp -d)
NAME="syntra-$VERSION"
TREE="$STAGE/$NAME"
mkdir -p "$TREE"

git ls-files -- . \
  ':(exclude)docs/**' \
  ':(exclude)e2e/**' \
  ':(exclude).github/**' \
  ':(exclude)*.md' \
  > "$STAGE/manifest.txt"
tar -cf - -T "$STAGE/manifest.txt" | tar -xf - -C "$TREE"

[ -f apps/web/dist/index.html ] || pnpm --filter @syntra/web build
mkdir -p "$TREE/apps/web"
cp -a apps/web/dist "$TREE/apps/web/dist"

printf '%s\n' "$VERSION" > "$TREE/VERSION"
cat > "$TREE/RELEASE.json" <<JSON
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$(git rev-parse HEAD)",
  "migrations": []
}
JSON

if [ -n "$MUTATE" ]; then
  ( cd "$TREE" && eval "$MUTATE" )
fi

tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/RELEASE.json$"
tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/apps/web/dist/index.html$"
tar -tzf "$OUT/$NAME.tar.gz" | grep -q "^$NAME/pnpm-lock.yaml$"

rm -rf "$STAGE"
echo "built $OUT/$NAME.tar.gz"
