#!/usr/bin/env bash
# Run the cyrano proxy with environment-variable configuration.
# Edit the values below for local dev; production deployments should inject
# these via their own secrets/env mechanism rather than sourcing this file.
set -euo pipefail

# ── Listen ────────────────────────────────────────────────────────────────────
export CYRANO_PORT=9081
export CYRANO_HOSTNAME=localhost

# ── TLS (leave HTTPS_ENABLED=false for plain HTTP in local dev) ───────────────
export CYRANO_HTTPS_ENABLED=false
export CYRANO_HTTPS_PORT=9444
export CYRANO_SSL_CERT=
export CYRANO_SSL_KEY=

# ── Proxy mode ────────────────────────────────────────────────────────────────
export CYRANO_MODE=webproxy

# ── Cookie name ───────────────────────────────────────────────────────────────
export CYRANO_SECRET_COOKIE=crnsct

# ── Endpoint paths ────────────────────────────────────────────────────────────
export CYRANO_REWRITER_JS_PATH=/rewriter.js
export CYRANO_HEAD_INJECTION_PATH=/head-injection
export CYRANO_COOKIES_JSON_PATH=/cookies.json

# ── Redis (optional; proxy falls back to in-memory if unreachable) ────────────
export REDIS_HOST=127.0.0.1
export REDIS_PORT=6379

# ── Locate binary and assets relative to this script ─────────────────────────
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
binary="$repo_root/go/assets/cyrano"
assets="$repo_root/go/assets"

if [[ ! -x "$binary" ]]; then
  echo "binary not found at $binary — run go/scripts/build.sh first" >&2
  exit 1
fi

exec "$binary" --assets "$assets" --log-level debug
