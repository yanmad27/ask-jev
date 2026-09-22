#!/usr/bin/env node
/** PreToolUse: Jev tự allow việc rõ ràng an toàn, tự ask khi rõ ràng nguy hiểm, im lặng khi lửng lơ. */
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate } from "../../lib/gate.mjs";

const CRITERIA = {
  true: "Read-only, or a reversible edit scoped inside the workspace, in service of the current task",
  false: "Deletes/overwrites outside the workspace, force-push, rm -rf, secrets exfiltration, network writes, pushing to a remote (even non-force), package publish, or anything else irreversible",
};

/** Bash: lệnh thật. Còn lại (Edit/Write/MultiEdit/NotebookEdit): tên tool + file. */
function subject(input) {
  const ti = input.tool_input ?? {};
  const text = input.tool_name === "Bash" ? ti.command : `${input.tool_name} ${ti.file_path ?? ti.notebook_path ?? ""}`;
  return truncate(text ?? "", 120);
}

async function main() {
  if (!enabled("permission")) return;
  const input = readStdinJson();
  if (!input || !/^(Bash|Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name ?? "")) return;
  if (input.permission_mode === "bypassPermissions") return; // đã tự allow hết rồi, hỏi Jev vô ích

  const state = buildState({
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    action: { tool: input.tool_name, input: input.tool_input },
  });
  if (!hasContext(state)) return;

  const answers = await askJev(apiKey(), state, {
    safe: {
      type: "boolean",
      instructions: { question: "Is this action safe to run without asking the user?", focus: FOCUS },
      criteria: CRITERIA,
    },
  }, "gate:permission", 4000).catch(() => null);
  if (!answers) return;

  const p = answers.safe.probability;
  const label = p >= 0.5 ? "safe" : "risky";
  const logFields = {
    kind: "decision", source: "hook", gate: "permission", question: subject(input),
    label, confidence: label === "safe" ? p : 1 - p, reason: truncate(CRITERIA[label === "safe"], 160),
  };

  if (p >= 0.9) {
    logEvent({ ...logFields, outcome: "allow" });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `Jev: safe (${p.toFixed(2)})` },
    }));
  } else if (p <= 0.2) {
    logEvent({ ...logFields, outcome: "ask" });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Jev: looks unsafe (p(safe)=${p.toFixed(2)}) — irreversible or out-of-scope. Ask the user first.`,
      },
    }));
  } else {
    logEvent({ ...logFields, outcome: "unsure" });
  }
}

main().catch(() => {});
