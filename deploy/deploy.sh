#!/usr/bin/env bash
# VERTIGO harness — deploy or redeploy on the server.
#
# Run it ON THE SERVER, from the repository root: deploy/deploy.sh
# It stamps the served revision from the checked-out HEAD, rebuilds only what changed, and refuses to start a
# container whose stamp would not describe its source.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f deploy/.env ] || { echo "deploy/.env is missing. Copy deploy/.env.example and fill it in."; exit 1; }

# Notion token (W3.5a): NOTION_TOKEN is canonical, NOTION_READ_TOKEN is accepted for one release. Refuse to start
# rather than silently pick a Notion authority. Values are compared, never printed.
envval() { { grep -E "^$1=" deploy/.env || true; } | tail -n 1 | cut -d= -f2-; }
NT="$(envval NOTION_TOKEN)"; NRT="$(envval NOTION_READ_TOKEN)"
if [ -z "$NT" ] && [ -z "$NRT" ]; then
  echo "deploy/.env sets no Notion token. Set NOTION_TOKEN (NOTION_READ_TOKEN is still accepted for one release)."
  exit 1
fi
if [ -n "$NT" ] && [ -n "$NRT" ] && [ "$NT" != "$NRT" ]; then
  echo "deploy/.env sets NOTION_TOKEN and NOTION_READ_TOKEN to different values. Keep only NOTION_TOKEN, then deploy."
  exit 1
fi
unset NT NRT

# Fail closed instead of keeping two active Sales registries. Migrate byte-exact with a private backup
# before invoking this script; it deliberately does not guess an authority or migrate during deployment.
[ ! -e config/sales-runtimes.local.json ] || { echo "config/sales-runtimes.local.json must be migrated to config/runtime-state/ before deploy."; exit 1; }
[ -f config/runtime-state/sales-runtimes.local.json ] || { echo "config/runtime-state/sales-runtimes.local.json is missing."; exit 1; }

REV="$(git rev-parse --verify HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree is dirty. The endpoint stamps a revision that must describe exactly what it serves."
  echo "Commit or stash first, then deploy."
  exit 1
fi

# The fingerprint covers the files that change behaviour without changing the revision.
digest() { [ -f "$1" ] && shasum -a 256 "$1" | awk '{print $1}' || printf MISSING; }
FP="$({
  printf 'principals=%s\n' "$(digest config/principals.local.json)"
  printf 'sales=%s\n' "$(digest config/runtime-state/sales-runtimes.local.json)"
  printf 'tokens=%s\n' "$(digest config/http-tokens.local.json)"
  printf 'skill=%s\n' "$(digest packages/plugin/SKILL.candidate.md)"
  printf 'meta_readonly_status=%s\n' "$(envval HARNESS_META_RECOVERY_STATUS_PRINCIPALS)"
} | shasum -a 256 | awk '{print $1}')"

# Rewrite only the two stamped lines; every secret in the file is left untouched.
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
grep -vE '^(HARNESS_BUILD_REVISION|HARNESS_CONFIG_FINGERPRINT)=' deploy/.env > "$tmp"
printf 'HARNESS_BUILD_REVISION=%s\nHARNESS_CONFIG_FINGERPRINT=%s\n' "$REV" "$FP" >> "$tmp"
cat "$tmp" > deploy/.env

cd deploy
docker compose --env-file .env up -d --build

echo
echo "Waiting for the endpoint to answer…"
DOMAIN="$(grep '^HARNESS_DOMAIN=' .env | cut -d= -f2-)"
for i in $(seq 1 60); do
  sleep 2
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "https://$DOMAIN/mcp" || true)"
  # 401 is the correct answer to a token-less probe: the endpoint is up and refusing, as designed.
  case "$code" in 401|405|400) echo "up after $((i*2))s (HTTP $code — reachable, refusing an unauthenticated probe)"; break;; esac
  [ "$i" = 60 ] && { echo "still not answering after 120s — check: docker compose logs --tail 50"; exit 1; }
done

echo
echo "Served revision: $REV"
echo "Verify from a client that an initialize handshake succeeds before handing any test to a seller."
