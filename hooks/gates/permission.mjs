#!/usr/bin/env node
/** PreToolUse: Jev chỉ tự allow khi VỪA safe VỪA không destructive; mọi trường hợp khác → ask. */
import { readFileSync } from "node:fs";
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate, autonomy, DESTRUCTIVE } from "../../lib/gate.mjs";
import { env } from "../../lib/env.mjs";

const SAFE = { true: "Read-only, or a reversible edit scoped inside the workspace, in service of the current task",
  false: "Deletes/overwrites outside the workspace, force-push, rm -rf, secrets exfiltration, network writes, pushing to a remote (even non-force), package publish, or anything else irreversible" };

function subject(input) {
  const ti = input.tool_input ?? {};
  return truncate((input.tool_name === "Bash" ? ti.command : `${input.tool_name} ${ti.file_path ?? ti.notebook_path ?? ""}`) ?? "", 120);
}

/** Edit/Write/MultiEdit: nội dung thật trước/sau, không chỉ đường dẫn — Jev thấy đúng thay đổi. */
function beforeAfter(input) {
  const ti = input.tool_input ?? {};
  if (input.tool_name === "Write") {
    let before = "";
    try { before = readFileSync(ti.file_path, "utf8"); } catch {}
    return { before: truncate(before, 4_000), after: truncate(ti.content ?? "", 4_000) };
  }
  if (input.tool_name === "Edit") return { before: truncate(ti.old_string ?? "", 4_000), after: truncate(ti.new_string ?? "", 4_000) };
  if (input.tool_name === "MultiEdit") {
    const edits = ti.edits ?? [];
    return { before: truncate(edits.map((e) => e.old_string).join("\n---\n"), 4_000), after: truncate(edits.map((e) => e.new_string).join("\n---\n"), 4_000) };
  }
  return {};
}

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
}

async function main() {
  if (!enabled("permission")) return;
  const input = readStdinJson();
  if (!input || !/^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name ?? "")) return;
  if (input.permission_mode === "bypassPermissions") return; // đã tự allow hết rồi, hỏi Jev vô ích

  const mode = autonomy();
  const allowThreshold = Number(env("ALLOW_THRESHOLD", mode === "full" ? 0.8 : 0.9));
  const key = apiKey();
  const { state, sizes } = buildState({
    transcriptPath: input.transcript_path, cwd: input.cwd, sessionId: input.session_id,
    action: { tool: input.tool_name, input: input.tool_input, ...beforeAfter(input) },
  });
  if (!hasContext(state)) return;

  // destructive hỏi CÙNG lúc với safe — fast-allow trước đây chỉ hỏi safe, bỏ qua destructive: lỗ hổng.
  const answers = await askJev(key, state, {
    safe: { type: "boolean", instructions: { question: "Is this action safe to run without asking the user?", focus: FOCUS }, criteria: SAFE },
    destructive: { type: "boolean", instructions: { question: "Would this action be destructive or irreversible?", focus: FOCUS }, criteria: DESTRUCTIVE },
  }, "gate:permission", 4000, sizes).catch(() => null);
  if (!answers) return;
  const p = answers.safe?.probability;
  const dp = answers.destructive?.probability;
  const base = { kind: "decision", source: "hook", gate: "permission", session_id: input.session_id, question: subject(input) };

  // Sàn cứng, kiểm TRƯỚC, cả hai mode — autonomy chỉ chỉnh làn nhanh, không đụng vào đây.
  if (dp === undefined || dp >= 0.6) {
    logEvent({ ...base, label: "destructive", confidence: dp ?? 1, outcome: "ask", reason: truncate(DESTRUCTIVE.true, 160) });
    respond("ask", `Jev: possibly destructive (p=${dp?.toFixed(2) ?? "?"}) — ask the user first.`);
    return;
  }

  if (p !== undefined && p >= allowThreshold && dp < 0.3) {
    logEvent({ ...base, label: "safe", confidence: p, outcome: "allow", reason: truncate(SAFE.true, 160) });
    respond("allow", `Jev: safe (${p.toFixed(2)}), not destructive (${dp.toFixed(2)})`);
    return;
  }

  // Mọi trường hợp còn lại — kể cả safe mode dưới threshold của nó dù destructive thấp — ask.
  const label = p === undefined ? "unsure" : p >= 0.5 ? "safe" : "risky";
  logEvent({ ...base, label, confidence: p ?? 1 - dp, outcome: "ask", reason: truncate(SAFE.false, 160) });
  respond("ask", `Jev: safe=${p?.toFixed(2) ?? "?"} destructive=${dp.toFixed(2)} — ask the user first.`);
}

main().catch(() => {});
