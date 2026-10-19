#!/usr/bin/env bash
# Exports the legacy `avosbooks` Worker: script settings/bindings, source, and every key/value in the KV
# namespaces of the account. Output goes under $1 (default ./avosbooks-export). Needs CLOUDFLARE_API_TOKEN.
set -euo pipefail
OUT=${1:-avosbooks-export}; mkdir -p "$OUT/kv" "$OUT/src"
ACC=${CLOUDFLARE_ACCOUNT_ID:-175b338a542282c642c044ffd2593bb9}
API="https://api.cloudflare.com/client/v4/accounts/$ACC"
auth="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

echo "== worker settings"
curl -sS -H "$auth" "$API/workers/scripts/avosbooks/settings" -o "$OUT/worker-settings.json" || echo "settings: not readable"
python3 scripts/export-avosbooks-helper.py bindings "$OUT" || true

echo "== worker source"
curl -sS -H "$auth" "$API/workers/scripts/avosbooks/content/v2" -o "$OUT/worker-content.raw" -D "$OUT/worker-content.headers" || echo "content: not readable"
python3 scripts/export-avosbooks-helper.py split "$OUT" || true

echo "== KV namespaces"
curl -sS -H "$auth" "$API/storage/kv/namespaces?per_page=100" -o "$OUT/kv-namespaces.json"
NS=$(python3 scripts/export-avosbooks-helper.py namespaces "$OUT")
echo "namespaces: $NS"
for pair in $NS; do
  id=${pair%%:*}; title=${pair#*:}
  dir="$OUT/kv/$title"; mkdir -p "$dir"
  cursor=""; : > "$dir/keys.jsonl"
  while :; do
    curl -sS -H "$auth" "$API/storage/kv/namespaces/$id/keys?limit=1000${cursor:+&cursor=$cursor}" -o "$dir/page.json"
    cursor=$(python3 scripts/export-avosbooks-helper.py page "$dir/page.json" "$dir/keys.jsonl")
    [ -z "$cursor" ] && break
  done
  rm -f "$dir/page.json"
  n=$(wc -l < "$dir/keys.jsonl"); echo "namespace $title ($id): $n keys"
  : > "$dir/index.tsv"; i=0
  while IFS= read -r line; do
    key=$(python3 scripts/export-avosbooks-helper.py keyname "$line")
    enc=$(python3 scripts/export-avosbooks-helper.py quote "$key")
    i=$((i+1)); f=$(printf "%05d" "$i")
    curl -sS -H "$auth" "$API/storage/kv/namespaces/$id/values/$enc" -o "$dir/$f.value" || true
    printf '%s\t%s\n' "$f" "$key" >> "$dir/index.tsv"
  done < "$dir/keys.jsonl"
done
echo "== done"; du -sh "$OUT"
