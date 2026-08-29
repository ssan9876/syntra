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
# The exclusions come from ops/release-excludes.txt, shared with
# release.yml's own assembly step, and the three tar assertions below are the
# same as release.yml's -- because a rehearsal against a differently-shaped
# artefact rehearses a different feature.
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

mapfile -t EXCLUDES < ops/release-excludes.txt
git ls-files -- . "${EXCLUDES[@]}" > "$STAGE/manifest.txt"
tar -cf - -T "$STAGE/manifest.txt" | tar -xf - -C "$TREE"

[ -f apps/web/dist/index.html ] || pnpm --filter @syntra/web build
mkdir -p "$TREE/apps/web"
cp -a apps/web/dist "$TREE/apps/web/dist"

# Turns a newline-separated list into a JSON array of strings, without a jq
# dependency this script otherwise has no reason to need. Escapes backslash
# and `"` only -- a migration directory name is a filesystem path component,
# not arbitrary text, but the escaping costs nothing and being wrong about
# that assumption once is enough reason to have it.
json_string_array() {
  local first=1 line esc
  printf '['
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ "$first" -eq 1 ] && first=0 || printf ','
    esc=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g')
    printf '"%s"' "$esc"
  done
  printf ']'
}

# Which migrations this release adds over the previous tag reachable from
# HEAD, computed the same way release.yml's "Work out what this release is"
# step does -- a rehearsal that always shipped "migrations": [] never
# exercised the one fact that decides whether an operator updates during the
# working day.
PREV=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)
if [ -n "$PREV" ]; then
  ADDED=$(git diff --name-only --diff-filter=A "$PREV" HEAD \
    -- packages/db/prisma/migrations \
    | awk -F/ '/migration.sql$/ {print $(NF-1)}' | sort -u)
else
  ADDED=$(ls packages/db/prisma/migrations | grep -v migration_lock || true)
fi
MIGRATIONS=$(printf '%s\n' "$ADDED" | json_string_array)

printf '%s\n' "$VERSION" > "$TREE/VERSION"
cat > "$TREE/RELEASE.json" <<JSON
{
  "version": "$VERSION",
  "released": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$(git rev-parse HEAD)",
  "migrations": $MIGRATIONS
}
JSON

if [ -n "$MUTATE" ]; then
  ( cd "$TREE" && eval "$MUTATE" )
fi

tar -czf "$OUT/$NAME.tar.gz" -C "$STAGE" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )

# `grep -c`, not `-q`: `-q` exits on its first match, closing the pipe while
# `tar -tzf` may still be writing -- under `set -o pipefail` that SIGPIPE is
# reported as this line's failure even though grep matched and the tarball
# is fine. `-c` reads to the end to produce a count, so it never closes the
# pipe early. release.yml had the same pattern and hit this every time the
# first tag ever pushed was built for real; fixed there too.
tar -tzf "$OUT/$NAME.tar.gz" | grep -c "^$NAME/RELEASE.json$" >/dev/null
tar -tzf "$OUT/$NAME.tar.gz" | grep -c "^$NAME/apps/web/dist/index.html$" >/dev/null
tar -tzf "$OUT/$NAME.tar.gz" | grep -c "^$NAME/pnpm-lock.yaml$" >/dev/null

rm -rf "$STAGE"
echo "built $OUT/$NAME.tar.gz"
