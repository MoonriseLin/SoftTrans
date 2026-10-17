#!/bin/sh
# Build the Shadowrocket config served at https://mio.pantsu.uk/rules/sr_cnip_ad.conf:
# the upstream "cnip + ad block" rules, plus the SoftTrans rules at the top of [Rule],
# with update-url pointing back here so Shadowrocket's own updates keep the fix.
#   sh shadowrocket/build.sh [output-file]
# Run daily by softdrop-rules.timer (see deploy/).
set -eu
UPSTREAM=https://johnshall.github.io/Shadowrocket-ADBlock-Rules-Forever/sr_cnip_ad.conf
SELF_URL=https://mio.pantsu.uk/rules/sr_cnip_ad.conf
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-/var/www/softdrop-rules/sr_cnip_ad.conf}
TMP=$(mktemp)
trap 'rm -f "$TMP" "$TMP.new"' EXIT

curl -fsS --max-time 120 -o "$TMP" "$UPSTREAM"

# Sanity checks: refuse to publish a truncated or unexpected download.
size=$(wc -c < "$TMP")
[ "$size" -gt 500000 ] || { echo "upstream too small ($size bytes), keeping the old file" >&2; exit 1; }
grep -q '^\[General\]' "$TMP" && grep -q '^\[Rule\]' "$TMP" && grep -q '^FINAL,' "$TMP" \
  || { echo "upstream missing [General]/[Rule]/FINAL, keeping the old file" >&2; exit 1; }

# Drop any update-url upstream sets, add ours at the end of [General],
# and insert the SoftTrans block right after the [Rule] header.
awk -v self="$SELF_URL" -v rules="$HERE/softtrans.rules" '
  /^update-url[ \t]*=/ { next }
  /^\[Rule\]/ && !done {
    print "update-url = " self
    print ""
    print
    while ((getline line < rules) > 0) print line
    print ""
    done = 1
    next
  }
  { print }
' "$TMP" > "$TMP.new"

grep -q '^IP-CIDR,45.89.232.91/32,DIRECT' "$TMP.new" || { echo "patch did not apply" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
install -m 0644 "$TMP.new" "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "built $OUT ($(wc -l < "$OUT") lines) from $UPSTREAM"
