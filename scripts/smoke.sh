#!/usr/bin/env bash
# Live smoke test. Usage: scripts/smoke.sh <base-url> <access-team-domain>
# Passes in either state: (a) Access not yet on → API gated with 401, deep health proves D1+R2, page served;
#                         (b) Access on → every request redirects to the team login page.
set -euo pipefail
URL="$1"; TEAM="$2"
echo "Testing $URL"
code=$(curl -sS --max-time 20 -o /tmp/body -w "%{http_code}" -D /tmp/hdr "$URL/api/health?deep=1")
loc=$(grep -i '^location:' /tmp/hdr | tr -d '\r' | awk '{print $2}' || true)
body=$(cat /tmp/body)
echo "status $code${loc:+, location $loc}"
if grep -q 'Just a moment' /tmp/body; then
  echo "::error::$URL serves a Cloudflare challenge page to automated requests. In the zone: Security → Settings → Security level Medium, Bot Fight Mode off, or a WAF Skip rule for this hostname."; exit 1
fi
if [ "$code" = "302" ] && echo "$loc" | grep -q "cloudflareaccess.com" && ! echo "$loc" | grep -q "$TEAM"; then
  echo "::error::$URL redirects to an Access team other than $TEAM: $loc — set ACCESS_TEAM_DOMAIN in wrangler.jsonc to that team's domain."; exit 1
fi
if [ "$code" = "302" ] && echo "$loc" | grep -q "$TEAM"; then
  echo "Access is ON: $URL redirects to $loc"
  me=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" "$URL/api/me"); echo "GET /api/me -> $me (expected 302 to login)"
  [ "$me" = "302" ] || { echo "::error::/api/me should redirect to Access, got $me"; exit 1; }
  echo "Access checks passed."
  exit 0
fi
echo "health: ${body:0:200}"
echo "$body" | grep -q '"ok":true'          || { echo "::error::health not ok ($code)"; exit 1; }
echo "$body" | grep -q '"db":"ok"'          || { echo "::error::D1 binding failed"; exit 1; }
echo "$body" | grep -q '"r2":"ok"'          || { echo "::error::R2 binding failed"; exit 1; }
echo "$body" | grep -q '"env":"production"' || { echo "::error::not the production environment"; exit 1; }
me=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" "$URL/api/me"); echo "GET /api/me -> $me"
[ "$me" = "401" ] || { echo "::error::/api/me should be 401 without a login, got $me"; exit 1; }
dev=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" -H "x-dev-user: shajianandan@gmail.com" "$URL/api/me"); echo "GET /api/me with dev header -> $dev"
[ "$dev" = "401" ] || { echo "::error::dev-user header must be ignored in production, got $dev"; exit 1; }
hook=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" -X POST "$URL/hooks/leads/website?key=wrong" -H 'content-type: application/json' -d '{"name":"probe"}'); echo "POST /hooks/leads/website (bad key) -> $hook"
[ "$hook" = "401" ] || { echo "::error::hook must reject a bad key with 401, got $hook"; exit 1; }
login=$(curl -sS --max-time 20 -o /dev/null -w "%{http_code}" -X POST "$URL/api/auth/login" -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"not-a-real-password"}'); echo "POST /api/auth/login (bad credentials) -> $login"
[ "$login" = "401" ] || { echo "::error::login must refuse bad credentials with 401, got $login"; exit 1; }
title=$(curl -sS --max-time 20 "$URL/" | grep -o '<title>[^<]*</title>'); echo "page: $title"
echo "$title" | grep -q 'AVOS' || { echo "::error::web app not served"; exit 1; }
echo "Deployment checks passed (in-app login active, no Access redirect)."
