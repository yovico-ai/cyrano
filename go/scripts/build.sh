#!/usr/bin/env bash
# Build the Go SSL VPN binary into go/assets/cyrano for local dev/debugging.
# Pre-bundles the TS client first so the bin and the static tree it serves
# stay in sync.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"

echo "→ building TS client → go/assets/client/"
( cd ts/client && npm run build )

echo "→ building Go binary → go/assets/cyrano"
cd go/src
go build -trimpath -o "$repo_root/go/assets/cyrano" ./cmd/cyrano

echo "✓ done. run: go/scripts/run.sh"
