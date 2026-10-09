#!/bin/sh
# SPDX-License-Identifier: MIT
set -eu

repo=imortkz/openclaw-peer
version=${OPENCLAW_PEER_VERSION:-latest}
case "$version" in ''|*[!A-Za-z0-9._-]*) echo 'Invalid OPENCLAW_PEER_VERSION' >&2; exit 1;; esac
if [ "$version" != latest ]; then
  printf '%s\n' "$version" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ {ok=1} END {exit !ok}' || { echo 'Invalid OPENCLAW_PEER_VERSION' >&2; exit 1; }
fi
case "$(uname -s)" in Linux) platform=linux;; Darwin) platform=darwin;; *) echo 'Supported systems: Linux and macOS' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo 'Supported architectures: amd64 and arm64' >&2; exit 1;; esac
for cmd in tar awk mktemp; do command -v "$cmd" >/dev/null || { echo "Required command: $cmd" >&2; exit 1; }; done
if command -v sha256sum >/dev/null; then hash=sha256sum
elif command -v shasum >/dev/null; then hash=shasum
else echo 'Required command: sha256sum or shasum' >&2; exit 1; fi
asset="openclaw-peer-$platform-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0
trap 'exit 1' HUP INT TERM

if [ -n "${OPENCLAW_PEER_DOWNLOAD_ROOT:-}" ]; then
  case "$OPENCLAW_PEER_DOWNLOAD_ROOT" in https://*|file://*) ;; *) echo 'OPENCLAW_PEER_DOWNLOAD_ROOT must use https:// or file://' >&2; exit 1;; esac
  base=${OPENCLAW_PEER_DOWNLOAD_ROOT%/}
  mode=curl
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  mode=gh
else
  mode=curl
  if [ "$version" = latest ]; then
    redirect=$(curl -IsS --retry 2 --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code} %{redirect_url}' "https://github.com/$repo/releases/latest") || { echo "Cannot resolve latest release of $repo; check the network or set OPENCLAW_PEER_DOWNLOAD_ROOT" >&2; exit 1; }
    case "$redirect" in
      30[12378]" https://github.com/$repo/releases/tag/"*)
        tag=${redirect#*"https://github.com/$repo/releases/tag/"}
        printf '%s\n' "$tag" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/ {ok=1} END {exit !ok}' || { echo "Invalid latest release of $repo" >&2; exit 1; };;
      *) echo "Cannot resolve latest release of $repo; check the network or set OPENCLAW_PEER_DOWNLOAD_ROOT" >&2; exit 1;;
    esac
  else tag=$version; fi
  base="https://github.com/$repo/releases/download/$tag"
fi

if [ "$mode" = gh ]; then
  if [ "$version" = latest ]; then
    gh release download --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$tmp" || { echo "gh release download failed for $repo" >&2; exit 1; }
  else
    gh release download "$version" --repo "$repo" --pattern "$asset" --pattern SHA256SUMS --dir "$tmp" || { echo "gh release download failed for $repo" >&2; exit 1; }
  fi
else
  command -v curl >/dev/null || { echo 'Required command: curl' >&2; exit 1; }
  curl -fLsS --retry 2 "$base/$asset" -o "$tmp/$asset" || { echo "Cannot download $repo release; check the network or set OPENCLAW_PEER_DOWNLOAD_ROOT" >&2; exit 1; }
  curl -fLsS --retry 2 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo "Cannot download $repo checksums; check the network or set OPENCLAW_PEER_DOWNLOAD_ROOT" >&2; exit 1; }
fi

expected=$(awk -v file="$asset" '
  $2 == file { count++; if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/) bad=1; value=$1 }
  END { if (count != 1 || bad) exit 1; print value }
' "$tmp/SHA256SUMS") || { echo 'Missing, invalid or ambiguous checksum' >&2; exit 1; }
if [ "$hash" = sha256sum ]; then actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
else actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || { echo 'Release checksum mismatch' >&2; exit 1; }
tar -tzf "$tmp/$asset" > "$tmp/members"
tar -tvzf "$tmp/$asset" > "$tmp/listing"
if awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}' "$tmp/members" ||
  awk '!/^[-d]/ {bad=1} END {exit !bad}' "$tmp/listing" ||
  [ "$(awk 'END {print NR}' "$tmp/members")" != "$(awk 'END {print NR}' "$tmp/listing")" ]; then echo 'Unsafe archive member' >&2; exit 1; fi
mkdir "$tmp/payload"
tar -xzf "$tmp/$asset" -C "$tmp/payload"
[ "$(cat "$tmp/payload/ROLE")" = openclaw ] || { echo 'Wrong release role' >&2; exit 1; }
sh "$tmp/payload/install" </dev/null
