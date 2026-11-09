#!/usr/bin/env bash
# Stops the tunnel and the harness started by scripts/serve.sh (PostgreSQL is left running).
cd "$(dirname "$0")/.."
for p in tunnel harness; do
  [ -f ".run/$p.pid" ] && kill "$(cat ".run/$p.pid")" 2>/dev/null
  rm -f ".run/$p.pid"
done
rm -f .run/public-url
echo "stopped (PostgreSQL left running; stop it with: /opt/homebrew/opt/postgresql@14/bin/pg_ctl -D /opt/homebrew/var/postgresql@14 stop)"
