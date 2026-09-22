#!/usr/bin/env node
/** PreToolUse: fast-allow tool đọc-only tĩnh trước (không gọi Jev), còn lại hỏi Jev cả safe lẫn destructive cùng lúc. */
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import {
  enabled, readStdinJson, FOCUS, autonomy, DESTRUCTIVE, SAFE, decidePermission, isReadOnlyFastPath, subject, beforeAfter,
} from "../../lib/gate.mjs";
import { env } from "../../lib/env.mjs";

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
}

function logDecision(input, extra) {
  logEvent({ kind: "decision", source: "hook", gate: "permission", session_id: input.session_id, question: subject(input), ...extra });
}

async function main() {
  if (!enabled("permission")) return;
  const input = readStdinJson();
  // matcher "*" nay bắt mọi tool; AskUserQuestion có hook riêng (ask-jev.mjs) nên tự loại ở đây.
  if (!input || !input.tool_name || input.tool_name === "AskUserQuestion") return;
  if (input.permission_mode === "bypassPermissions") return; // đã tự allow hết rồi, hỏi Jev vô ích

  if (isReadOnlyFastPath(input.tool_name)) {
    logDecision(input, { label: "safe", confidence: 1, outcome: "allow", reason: "read-only tool" });
    respond("allow", "Jev: read-only tool, fast-allowed without a network call.");
    return;
  }

  const mode = autonomy();
  const allowThreshold = Number(env("ALLOW_THRESHOLD", mode === "full" ? 0.8 : 0.9));
  const key = apiKey();
  const { state, sizes } = buildState({
    transcriptPath: input.transcript_path, cwd: input.cwd, sessionId: input.session_id,
    action: { tool: input.tool_name, input: input.tool_input, ...beforeAfter(input) },
  });
  if (!hasContext(state)) return;

  const answers = await askJev(key, state, {
    safe: { type: "boolean", instructions: { question: "Is this action safe to run without asking the user?", focus: FOCUS }, criteria: SAFE },
    destructive: { type: "boolean", instructions: { question: "Would this action be destructive or irreversible?", focus: FOCUS }, criteria: DESTRUCTIVE },
  }, "gate:permission", 4000, sizes).catch(() => null);
  if (!answers) return;

  const p = answers.safe?.probability;
  const dp = answers.destructive?.probability;
  const result = decidePermission(p, dp, allowThreshold);
  logDecision(input, { label: result.label, confidence: result.confidence, outcome: result.decision, reason: result.reason });
  respond(result.decision, `Jev: safe=${p?.toFixed(2) ?? "?"} destructive=${dp?.toFixed(2) ?? "?"} — ${result.decision === "allow" ? "auto-allowed" : "ask the user first"}.`);
}

main().catch(() => {});
