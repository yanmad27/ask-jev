#!/usr/bin/env bash
# Vendors lib/*.mjs into paseo-plugin/shared/ verbatim (Paseo stages only paseo-plugin/,
# see paseo-plugin/README.md). Run with --check to fail if a copy has drifted (CI parity gate).
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(answer-policy.mjs context.mjs env.mjs gate.mjs jev.mjs stats.mjs)

if [[ "${1:-}" == "--check" ]]; then
  status=0
  for f in "${FILES[@]}"; do
    if ! diff -q "lib/$f" "paseo-plugin/shared/$f" >/dev/null 2>&1; then
      echo "paseo-plugin/shared/$f is out of sync with lib/$f — run npm run sync-shared (in paseo-plugin/)" >&2
      status=1
    fi
  done
  exit $status
fi

for f in "${FILES[@]}"; do
  cp "lib/$f" "paseo-plugin/shared/$f"
done
