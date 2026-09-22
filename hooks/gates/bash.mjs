#!/usr/bin/env node
/** PostToolUse (Bash): Jev gắn thêm ngữ cảnh khi lệnh không "success" thẳng thớm. */
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, tailText, truncate, FOCUS } from "../../lib/gate.mjs";

// tool_response chưa có schema chốt trong docs — chấp cả string lẫn object {stdout|output|content}.
function responseText(r) {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") return r.stdout ?? r.output ?? r.content ?? JSON.stringify(r);
  return "";
}

async function main() {
  if (!enabled("bash")) return;
  const input = readStdinJson();
  if (!input || input.tool_name !== "Bash") return;

  const output = tailText(responseText(input.tool_response), 60);
  const { state, sizes } = buildState({
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
    sessionId: input.session_id,
    action: { command: input.tool_input?.command ?? "", output },
  });
  if (!hasContext(state)) return;

  const opts = {
    success: { what: "Ran cleanly and did what it was meant to", not_for: "error, tests_failed, needs_attention" },
    error: { what: "Failed outright: non-zero exit, exception, command not found", not_for: "success, tests_failed, needs_attention" },
    tests_failed: { what: "A test runner ran and reported failing tests", not_for: "success, error, needs_attention" },
    needs_attention: { what: "Ran, but produced warnings, deprecations, or an ambiguous/partial result worth a human look", not_for: "success, error, tests_failed" },
  };
  const answers = await askJev(apiKey(), state, {
    result: { type: "choice", instructions: { question: "How did this command's execution turn out?", focus: FOCUS }, criteria: opts },
  }, "gate:bash", 4000, sizes).catch(() => null);
  const choice = answers?.result?.choice;
  if (!choice) return;
  const p = answers.result.probabilities?.[choice] ?? 1;
  logEvent({
    kind: "decision", source: "hook", gate: "bash", outcome: choice, session_id: input.session_id,
    question: truncate(input.tool_input?.command ?? "", 120),
    label: choice, confidence: p, reason: truncate(opts[choice]?.what ?? "", 160),
  });
  if (choice !== "success" && p >= 0.8) {
    const summary = output.trim().split("\n").pop() ?? "";
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Jev: ${choice} (${p.toFixed(2)}) — ${summary}` },
    }));
  }
}

main().catch(() => {});
