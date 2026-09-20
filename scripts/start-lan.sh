#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-3100}"
export PORT
export NODE_ENV=development
# Empty APP_ORIGIN makes same-origin checks follow the host used by the client.
export APP_ORIGIN=

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -z "${IP:-}" ]]; then
  IP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
fi

echo "NEXUS ARENA LAN mode: http://${IP:-<VM-IP>}:$PORT"
echo "Phone/PC must be on the same network; do not use localhost on the phone."
exec node server.js