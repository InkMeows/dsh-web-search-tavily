#!/bin/bash
# Build the host entry (src/ → lib/) with the project's own TypeScript.
# Self-healing dependency links: node_modules/@deepseek-ai/* are junctions
# into the local DSH checkout (DSH_CHECKOUT env or the known default), created
# idempotently by scripts/ensure-links.mjs before tsc runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/ensure-links.mjs
"$ROOT/node_modules/.bin/tsc" -p tsconfig.json
echo "=== Build complete ==="