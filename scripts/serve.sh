#!/usr/bin/env bash
# Runs the VERTIGO harness as a remote MCP endpoint for ChatGPT: PostgreSQL (durable store) + harness (HTTP) + HTTPS tunnel.
# Usage:  scripts/serve.sh [quick|named]
#   quick (default): random https://<name>.trycloudflare.com URL, no account needed
#   named:           https://os.studiovertigo.io through a Cloudflare named tunnel (~/.cloudflared/vertigo-os.yml)
# Optional: SPEC_ROOT=<page id or url> points the harness at a specific META spec root (e.g. the PT-PRO-001 fixture).
# Secrets stay in the repo-root env file and config/*.local*; only the public URL is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-quick}"
ENV_FILE="${ENV_FILE:-$PWD/.env}"
# Runtime artifacts carry credentials-adjacent material: harness.log records every request line, tunnel.log
# records the public URL, and public-url is the endpoint an attacker would need. Everything this script creates
# is therefore owner-only — umask 077 covers the redirections below, which bash performs before any chmod could.
umask 077
RUN_DIR=".run"; mkdir -p "$RUN_DIR"; chmod 700 "$RUN_DIR"
PG_CTL=/opt/homebrew/opt/postgresql@14/bin/pg_ctl; PG_DATA=/opt/homebrew/var/postgresql@14
"$PG_CTL" -D "$PG_DATA" status >/dev/null 2>&1 || "$PG_CTL" -D "$PG_DATA" start -w >/dev/null
export HARNESS_TRANSPORT=http
export HARNESS_HTTP_HOST=127.0.0.1 HARNESS_HTTP_PORT="${HARNESS_HTTP_PORT:-8787}"
export DATABASE_URL="${DATABASE_URL:-postgres://$(whoami)@localhost:5432/vertigo_harness}"
export HARNESS_HTTP_TOKENS_FILE="${HARNESS_HTTP_TOKENS_FILE:-$PWD/config/http-tokens.local.json}"
export PRINCIPALS_FILE="${PRINCIPALS_FILE:-$PWD/config/principals.local.json}"
export SALES_RUNTIME_REGISTRY_FILE="${SALES_RUNTIME_REGISTRY_FILE:-$PWD/config/sales-runtimes.local.json}"
[ -n "${SPEC_ROOT:-}" ] && export VERTIGO_META_SPEC_ROOT="$SPEC_ROOT"
# A remote initialize response must identify the exact code and deployment configuration it is serving. These
# values contain no secret: config material is represented only by a SHA-256 digest. Explicit CI-provided values
# win; the local launcher derives them from the checkout and the files Node will actually read.
export HARNESS_BUILD_REVISION="${HARNESS_BUILD_REVISION:-$(git rev-parse --verify HEAD)}"
if [ -z "${HARNESS_BUILD_DIRTY:-}" ]; then
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then export HARNESS_BUILD_DIRTY=true; else export HARNESS_BUILD_DIRTY=false; fi
fi
file_digest() { if [ -f "$1" ]; then shasum -a 256 "$1" | awk '{print $1}'; else printf 'MISSING'; fi; }
if [ -z "${HARNESS_CONFIG_FINGERPRINT:-}" ]; then
  HARNESS_CONFIG_FINGERPRINT="$({
    printf 'env=%s\n' "$(file_digest "$ENV_FILE")"
    printf 'tokens=%s\n' "$(file_digest "$HARNESS_HTTP_TOKENS_FILE")"
    printf 'principals=%s\n' "$(file_digest "$PRINCIPALS_FILE")"
    printf 'sales=%s\n' "$(file_digest "$SALES_RUNTIME_REGISTRY_FILE")"
    printf 'transport=%s\nhost=%s\nport=%s\ndatabase_configured=%s\n' "$HARNESS_TRANSPORT" "$HARNESS_HTTP_HOST" "$HARNESS_HTTP_PORT" "${DATABASE_URL:+yes}"
  } | shasum -a 256 | awk '{print $1}')"
  export HARNESS_CONFIG_FINGERPRINT
fi
# Variables exported here take precedence: Node's --env-file never overrides an existing variable.
( cd packages/harness && exec node --env-file="$ENV_FILE" src/index.ts ) > "$RUN_DIR/harness.log" 2>&1 &
echo $! > "$RUN_DIR/harness.pid"
for _ in $(seq 1 30); do grep -q listening "$RUN_DIR/harness.log" 2>/dev/null && break; sleep 0.5; done
grep -q listening "$RUN_DIR/harness.log" || { echo "harness failed to start:"; cat "$RUN_DIR/harness.log"; exit 1; }
if [ "$MODE" = "named" ]; then
  cloudflared tunnel --config "$HOME/.cloudflared/vertigo-os.yml" run > "$RUN_DIR/tunnel.log" 2>&1 &
  echo $! > "$RUN_DIR/tunnel.pid"
  echo "https://os.studiovertigo.io/mcp" > "$RUN_DIR/public-url"
else
  cloudflared tunnel --url "http://127.0.0.1:$HARNESS_HTTP_PORT" > "$RUN_DIR/tunnel.log" 2>&1 &
  echo $! > "$RUN_DIR/tunnel.pid"
  URL=""
  for _ in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" | head -1 || true); [ -n "$URL" ] && break; sleep 0.5; done
  [ -n "$URL" ] || { echo "tunnel failed:"; cat "$RUN_DIR/tunnel.log"; exit 1; }
  echo "$URL/mcp" > "$RUN_DIR/public-url"
fi
# Belt and braces for a .run/ inherited from an older, laxer run of this script: directories must stay
# traversable by the owner (0700), regular files owner-read/write only (0600).
find "$RUN_DIR" -type d -exec chmod 700 {} + 2>/dev/null || true
find "$RUN_DIR" -type f -exec chmod 600 {} + 2>/dev/null || true
echo "VERTIGO harness online: $(cat "$RUN_DIR/public-url")   (logs: $RUN_DIR/ 0700, files 0600; stop: scripts/stop.sh)"
