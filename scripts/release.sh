#!/usr/bin/env bash
# Cut a release of @salsita/docsync.
#
#   1. asks for the new version (shows the current one, refuses it and anything
#      not above it)
#   2. writes the version into package.json
#   3. turns the changelog's "## [Unreleased]" into "## [<version>] — <date>"
#      and puts a fresh, empty "## [Unreleased]" above it
#   4. commits both as "release <version>" and tags it v<version>
#   5. shows the commit and waits for a yes
#   6. pushes main and the tag; the tag run of .github/workflows/release.yml
#      publishes to npm and creates the GitHub release from the changelog
#
# Nothing leaves the machine before step 5. If you answer no, the commit and
# tag stay local; undo them with the command the script prints.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }
die() { say "release: $*" >&2; exit 1; }

# --- preconditions --------------------------------------------------------

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || die "on branch $branch, releases are cut from main"

[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"

git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  die "main and origin/main differ; pull or push first"
fi

grep -q '^## \[Unreleased\]' CHANGELOG.md || die "CHANGELOG.md has no [Unreleased] section"

unreleased=$(awk '/^## \[Unreleased\]/ { inside = 1; next } inside && /^## \[/ { exit } inside' CHANGELOG.md)
if [ -z "$(printf '%s' "$unreleased" | tr -d '[:space:]')" ]; then
  say "warning: the [Unreleased] section is empty; the release notes will be too"
fi

# --- the version ------------------------------------------------------------

current=$(node -p "require('./package.json').version")

# 0 when a > b, 1 otherwise. Numeric per dotted part, a prerelease sorts below
# its release.
above() {
  node -e '
    const parse = v => { const [core, pre] = v.split("-"); return [core.split(".").map(Number), pre ?? null]; };
    const [a, ap] = parse(process.argv[1]), [b, bp] = parse(process.argv[2]);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
    if (ap === bp) process.exit(1);
    if (ap === null) process.exit(0);
    if (bp === null) process.exit(1);
    process.exit(ap > bp ? 0 : 1);
  ' "$1" "$2"
}

say "current version: $current"
while :; do
  read -r -p "new version: " version
  version=${version#v}
  if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    say "  not a version (expected major.minor.patch, optionally -prerelease)"
  elif [ "$version" = "$current" ]; then
    say "  that is the current version; it has to go up"
  elif ! above "$version" "$current"; then
    say "  $version is below $current"
  elif git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
    say "  tag v$version already exists"
  else
    break
  fi
done

# --- the commit and the tag -------------------------------------------------

npm version "$version" --no-git-tag-version >/dev/null

date=$(date +%Y-%m-%d)
node -e '
  const fs = require("fs");
  const [version, date] = process.argv.slice(1);
  const heading = `## [${version}] — ${date}`;
  const s = fs.readFileSync("CHANGELOG.md", "utf8");
  fs.writeFileSync("CHANGELOG.md", s.replace(/^## \[Unreleased\][^\n]*\n/m, `## [Unreleased]\n\n${heading}\n`));
' "$version" "$date"

git add package.json CHANGELOG.md
git commit -q -m "release $version"
git tag -a "v$version" -m "v$version"

say
git --no-pager show --stat --format='%h %s' HEAD
say
say "release notes:"
printf '%s\n' "$unreleased" | sed 's/^/  /'
say

# --- the push -------------------------------------------------------------

read -r -p "push main and v$version to origin? [y/N] " answer
case "$answer" in
  y|Y|yes|YES) ;;
  *)
    say "not pushed. To undo:  git tag -d v$version && git reset --hard HEAD~1"
    exit 1
    ;;
esac

git push origin main "v$version"

say
say "pushed. The tag run publishes and creates the release:"
say "  https://github.com/salsita/docsync/actions/workflows/release.yml"
say "  https://github.com/salsita/docsync/releases/tag/v$version"
