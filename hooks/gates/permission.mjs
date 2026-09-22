#!/usr/bin/env node
/** PreToolUse: Jev tự allow việc rõ ràng an toàn, tự ask khi rõ ràng nguy hiểm hoặc destructive. */
import { readFileSync } from "node:fs";
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate, autonomy, DESTRUCTIVE } from "../../lib/gate.mjs";

const CRITERIA = {
  true: "Read-only, or a reversible edit scoped inside the workspace, in service of the current task",
  false: "Deletes/overwrites outside the workspace, force-push, rm -rf, secrets exfiltration, network writes, pushing to a remote (even non-force), package publish, or anything else irreversible",
};

function subject(input) {
  const ti = input.tool_input ?? {};
  const text = input.tool_name === "Bash" ? ti.command : `${input.tool_name} ${ti.file_path ?? ti.notebook_path ?? ""}`;
  return truncate(text ?? "", 120);
}

/** Edit/Write/MultiEdit: nội dung thật trước/sau, không chỉ đường dẫn — Jev thấy đúng thay đổi. */
function beforeAfter(input) {
  const ti = input.tool_input ?? {};
  if (input.tool_name === "Write") {
    let before = "";
    try { before = readFileSync(ti.file_path, "utf8"); } catch {}
    return { before: truncate(before, 4_000), after: truncate(ti.content ?? "", 4_000) };
  }
  if (input.tool_name === "Edit") {
    return { before: truncate(ti.old_string ?? "", 4_000), after: truncate(ti.new_string ?? "", 4_000) };
  }
  if (input.tool_name === "MultiEdit") {
    const edits = ti.edits ?? [];
    return {
      before: truncate(edits.map((e) => e.old_string).join("\n---\n"), 4_000),
      after: truncate(edits.map((e) => e.new_string).join("\n---\n"), 4_000),
    };
  }
  return {};
}

function respond(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
}

async function main() {
  if (!enabled("permission")) return;
  const input = readStdinJson();
  if (!input || !/^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name ?? "")) return;
  if (input.permission_mode === "bypassPermissions") return; // đã tự allow hết rồi, hỏi Jev vô ích

  const mode = autonomy();
  const allowThreshold = Number(process.env.JEV_ALLOW_THRESHOLD ?? (mode === "full" ? 0.8 : 0.9));
  const key = apiKey();

  const { state, sizes } = buildState({
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    sessionId: input.session_id,
    action: { tool: input.tool_name, input: input.tool_input, ...beforeAfter(input) },
  });
  if (!hasContext(state)) return;

  const answers = await askJev(key, state, {
    safe: { type: "boolean", instructions: { question: "Is this action safe to run without asking the user?", focus: FOCUS }, criteria: CRITERIA },
  }, "gate:permission", 4000, sizes).catch(() => null);
  if (!answers) return;

  const p = answers.safe.probability;
  const label = p >= 0.5 ? "safe" : "risky";
  const question = subject(input);
  const base = {
    kind: "decision", source: "hook", gate: "permission", session_id: input.session_id, question,
    label, confidence: label === "safe" ? p : 1 - p,
  };

  if (p >= allowThreshold) {
    logEvent({ ...base, outcome: "allow", reason: truncate(CRITERIA.true, 160) });
    respond("allow", `Jev: safe (${p.toFixed(2)})`);
    return;
  }
  if (p <= 0.2) {
    logEvent({ ...base, outcome: "ask", reason: truncate(CRITERIA.false, 160) });
    respond("ask", `Jev: looks unsafe (p(safe)=${p.toFixed(2)}) — irreversible or out-of-scope. Ask the user first.`);
    return;
  }

  // Vùng giữa: không đủ chắc an toàn hay không. Một bucket "unsure" bỏ lửng là vô dụng
  // (bài học thực tế, xem skills/ask-jev/SKILL.md "Delegation") — hỏi thẳng câu quyết
  // định được: có destructive không. Không thì allow, có thì ép hỏi (guardrail chung).
  const destructive = await askJev(key, state, {
    destructive: { type: "boolean", instructions: { question: "Would this action be destructive or irreversible?", focus: FOCUS }, criteria: DESTRUCTIVE },
  }, "gate:permission", 4000, sizes).catch(() => null);

  const dp = destructive?.destructive?.probability;
  if (dp === undefined) {
    logEvent({ ...base, outcome: "ask", reason: "Jev could not confirm whether this is destructive — ask the user first." });
    return;
  }
  if (dp < 0.3) {
    logEvent({ ...base, outcome: "allow", reason: truncate(DESTRUCTIVE.false, 160) });
    respond("allow", `Jev: not destructive (${dp.toFixed(2)})`);
    return;
  }
  logEvent({ ...base, outcome: "ask", reason: truncate(DESTRUCTIVE.true, 160) });
  respond("ask", `Jev: possibly destructive (p=${dp.toFixed(2)}) — ask the user first.`);
}

main().catch(() => {});
