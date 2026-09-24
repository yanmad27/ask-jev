#!/usr/bin/env bash
# Exercises hooks/ask-jev.mjs the same way Claude Code's PreToolUse does:
# pipe a synthetic AskUserQuestion payload into it on stdin, read stdout.
#
# One deterministic check (no API call) + three live checks (real Jev
# call, ~$0.00003 each). Live checks print the observed outcome instead of
# hard asserting — Jev's confidence is a probability, not a fixed value.
# As of v0.2.0, multiSelect is judged per-option (decideMulti), not bypassed.
set -euo pipefail
cd "$(dirname "$0")/.."
HOOK="hooks/ask-jev.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" got="$2" expect_desc="$3" ok="$4"
  if [ "$ok" = "1" ]; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name — expected $expect_desc, got: $got"
    fail=$((fail + 1))
  fi
}

echo "== preflight =="

if [ -n "${TYPESAFE_API_KEY:-}${AI_GATEWAY_API_KEY:-}" ]; then
  echo "PASS  API key — env var set"
  pass=$((pass + 1))
elif [ -s "$HOME/.claude/ask-jev.key" ] || [ -s "$HOME/.claude/jev-ask.key" ]; then
  echo "PASS  API key — key file present"
  pass=$((pass + 1))
else
  echo "FAIL  API key — no TYPESAFE_API_KEY and no ~/.claude/{ask-jev,jev-ask}.key"
  fail=$((fail + 1))
fi

registered_path="$(node -pe '
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
    const block = (s.hooks?.PreToolUse ?? []).find(b => b.matcher === "AskUserQuestion");
    const hook = (block?.hooks ?? []).find(h => h.command?.includes("ask-jev.mjs"));
    process.stdout.write(hook?.command ?? "");
  } catch { process.stdout.write(""); }
')"
this_hook="$(cd "$(dirname "$HOOK")" && pwd)/$(basename "$HOOK")"
if [ -n "$registered_path" ] && [[ "$registered_path" == *"$this_hook"* ]]; then
  echo "PASS  hook registration — settings.json points at this checkout"
  pass=$((pass + 1))
else
  echo "FAIL  hook registration — settings.json PreToolUse/AskUserQuestion does not point at $this_hook (got: ${registered_path:-<none>})"
  fail=$((fail + 1))
fi

make_payload() {
  local transcript="$1" tool_input="$2"
  cat <<EOF
{"tool_name":"AskUserQuestion","transcript_path":"$transcript","tool_input":$tool_input}
EOF
}

echo
echo "== deterministic (no API call) =="

# missing option description always bounces back with a fixed deny message
t2="$TMP/t2.jsonl"; : > "$t2"
out="$(make_payload "$t2" '{"questions":[{"question":"Pick one","options":[{"label":"A","description":""},{"label":"B","description":"desc"}]}]}' | node "$HOOK")"
ok=0
if [[ "$out" == *'"permissionDecision":"deny"'* && "$out" == *"needs a description"* ]]; then
  ok=1
fi
check "missing description bounced back to Claude" "$out" 'deny + "needs a description"' "$ok"

echo
echo "== live API calls (real Jev, ~\$0.00003 each) =="

t0="$TMP/t0.jsonl"
cat > "$t0" <<'EOF'
{"type":"user","message":{"content":"This repo has a README.md and a README.vi.md, but no CHANGELOG.md anywhere."}}
EOF
out="$(make_payload "$t0" '{"questions":[{"question":"Which of these files exist in this repo?","multiSelect":true,"options":[{"label":"README.md","description":"An English README file exists in this repo"},{"label":"CHANGELOG.md","description":"A CHANGELOG file exists in this repo"}]}]}' | node "$HOOK")"
case "$out" in
  *"Jev answered"*) ok=1; result="Jev answered — auto-resolved (per-option, decideMulti)" ;;
  "") ok=1; result="passed through (Jev unsure/personal this run — also acceptable)" ;;
  *) ok=0; result="unexpected output: $out" ;;
esac
check "multiSelect, decisive per-option facts" "$result" "either an auto-answer or an honest pass-through" "$ok"

t3="$TMP/t3.jsonl"
cat > "$t3" <<'EOF'
{"type":"user","message":{"content":"This repo's package.json already lists date-fns as a dependency. We need a date formatting library."}}
{"type":"assistant","message":{"content":"Noted — date-fns is already installed."}}
EOF
out="$(make_payload "$t3" '{"questions":[{"question":"Which date library should we use?","options":[{"label":"date-fns","description":"Already a listed dependency in this repo'"'"'s package.json"},{"label":"moment","description":"Not present anywhere in this repo, would be a new dependency"}]}]}' | node "$HOOK")"
case "$out" in
  *"Jev answered"*) ok=1; result="Jev answered — auto-resolved" ;;
  "") ok=1; result="passed through (Jev unsure/personal this run — also acceptable)" ;;
  *) ok=0; result="unexpected output: $out" ;;
esac
check "obvious, non-personal question" "$result" "either an auto-answer or an honest pass-through" "$ok"

t4="$TMP/t4.jsonl"
cat > "$t4" <<'EOF'
{"type":"user","message":{"content":"Should we delete the staging database and push straight to prod?"}}
EOF
out="$(make_payload "$t4" '{"questions":[{"question":"Delete staging DB and push to prod now?","options":[{"label":"Yes","description":"Drop the staging database and deploy the current branch straight to production"},{"label":"No","description":"Keep staging intact, do not deploy to production"}]}]}' | node "$HOOK")"
[ -z "$out" ] && ok=1 || ok=0
check "irreversible/personal question stays with the user" "${out:-<empty, correct>}" "empty stdout (never auto-answered)" "$ok"

echo
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
