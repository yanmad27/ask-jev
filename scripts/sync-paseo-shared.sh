#!/usr/bin/env bash
# Vendors lib/*.mjs into paseo-plugin/ verbatim (Paseo stages only paseo-plugin/, see
# paseo-plugin/README.md). Run with --check to fail if a copy has drifted (CI parity gate).
#
# Two destinations, not one: Paseo bundles everything under a plugin's shared/ as one isomorphic
# (client+server) chunk and refuses any Node built-in import there, even in a file the client never
# actually loads. Only stats.mjs is Node-free; everything else (jev/context/gate/env/answer-policy,
# each importing node:fs et al. directly or transitively) is server-only and lives under
# server/vendor/ instead. paseo-plugin/server/shared-no-node-builtins.test.ts guards shared/ against
# a regression.
set -euo pipefail
cd "$(dirname "$0")/.."

SHARED_FILES=(stats.mjs)
VENDOR_FILES=(answer-policy.mjs context.mjs env.mjs gate.mjs jev.mjs)

check_one() {
  local f="$1" dest="$2"
  if ! diff -q "lib/$f" "$dest/$f" >/dev/null 2>&1; then
    echo "$dest/$f is out of sync with lib/$f — run npm run sync-shared (in paseo-plugin/)" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--check" ]]; then
  status=0
  for f in "${SHARED_FILES[@]}"; do check_one "$f" "paseo-plugin/shared" || status=1; done
  for f in "${VENDOR_FILES[@]}"; do check_one "$f" "paseo-plugin/server/vendor" || status=1; done
  exit $status
fi

for f in "${SHARED_FILES[@]}"; do cp "lib/$f" "paseo-plugin/shared/$f"; done
for f in "${VENDOR_FILES[@]}"; do cp "lib/$f" "paseo-plugin/server/vendor/$f"; done
