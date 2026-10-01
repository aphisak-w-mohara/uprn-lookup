#!/usr/bin/env bash
# Fetch the chunk set for the release named in public/version.json.
#
# Chunks are not committed: each release replaces all 5,088 of them and git
# history cannot shed them, so they would grow the repository by ~213 MiB a
# month forever. They are published as a GitHub Release asset instead, which
# sits outside git history.
#
# version.json is committed and pins the tarball's SHA-256. Release assets can
# be replaced by anyone with write access, so a mismatch fails the fetch rather
# than deploying whatever happens to be attached.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(jq -r '.version // empty' public/version.json)
want=$(jq -r '.chunksSha256 // empty' public/version.json)
[ -n "$version" ] || { echo "public/version.json has no version" >&2; exit 1; }
[ -n "$want" ]    || { echo "public/version.json has no chunksSha256" >&2; exit 1; }

tag="data-$version"
asset="chunks-$version.tar"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "fetching $asset from release $tag"
gh release download "$tag" --pattern "$asset" --dir "$tmp"

if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else
  got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)
fi
if [ "$got" != "$want" ]; then
  echo "checksum mismatch for $asset" >&2
  echo "  version.json pins $want" >&2
  echo "  release serves    $got" >&2
  exit 1
fi

rm -rf public/d
tar -xf "$tmp/$asset" -C public
[ -f "public/d/$version/manifest.bin" ] || { echo "archive has no d/$version/manifest.bin" >&2; exit 1; }
echo "ok: $(find "public/d/$version" -name '[0-9]*.bin' | wc -l | tr -d ' ') chunks in public/d/$version/"
