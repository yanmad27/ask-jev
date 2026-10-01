#!/usr/bin/env node
/** UserPromptSubmit: nhắc luật hỏi Jev mỗi lượt + xử lý prompt mập mờ (full: tự quyết, safe: cảnh báo). */
import { fileURLToPath } from "node:url";
import { apiKey, askJev, logEvent, NOT_CHAT, REQUEST_SHAPE, CRITERIA_SHAPE } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate, autonomy } from "../../lib/gate.mjs";
import { env } from "../../lib/env.mjs";

const jevPath = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const REMINDER = `Reminder: Jev advises; the user decides. The Jev CLI is only for your own internal judgements (model/tier choice, internal classification): echo '<json>' | node "${jevPath}" with <json> = ${REQUEST_SHAPE}; ${CRITERIA_SHAPE}. ${NOT_CHAT} (skill ask-jev). Act on an answer only at/above ASK_JEV_ASK_THRESHOLD and report \`Jev chose "X" (0.93)\`; below it, state your own manual choice. Anything the user would decide (taste, push/PR/merge/deploy, any external effect) goes through AskUserQuestion, never this CLI — Jev attaches advice there and the user decides. Verify checkable facts yourself first (read-only tool/command), state = the verbatim result. Never write your own description of the user into state — only raw evidence (their words/past choices) — and never ask Jev to judge your own output.`;

const AMBIGUOUS = {
  true: "Multiple materially different readings that would change the work",
  false: "Clear, or trivially disambiguated by the conversation so far",
};
const LITERAL = {
  true: "The most literal reading, combined with the current task context, is enough to act without clarification",
  false: "Multiple materially different readings remain even after considering the current task context",
};

async function judgePrompt(input) {
  if (!enabled("prompt")) return null;
  const prompt = input.prompt ?? "";
  if (prompt.length < 12 || prompt.startsWith("/")) return null;

  const { state, sizes } = buildState({
    transcriptPath: input.transcript_path, cwd: input.cwd, sessionId: input.session_id, action: { prompt },
  });
  if (!hasContext(state)) return null;
  const key = apiKey();

  if (autonomy() === "full") {
    const answers = await askJev(key, state, {
      literal: {
        type: "boolean",
        safe: false,
        instructions: { question: "Is the most literal reading of this prompt, taken with the current task context, actionable without clarification?", focus: FOCUS },
        criteria: LITERAL,
      },
    }, "gate:prompt", 4000, sizes).catch(() => null);
    const p = answers?.literal?.probability;
    if (p === undefined) return null;
    const label = p >= 0.7 ? "literal" : "assume";
    logEvent({
      kind: "decision", source: "hook", gate: "prompt", session_id: input.session_id, outcome: label,
      question: truncate(prompt, 4_000), label, confidence: label === "literal" ? p : 1 - p, reason: truncate(LITERAL[label === "literal"], 160),
    });
    return label === "literal"
      ? "Jev: proceed on the literal reading; state your assumption in one line, do not ask."
      : "Jev: ambiguous — pick the reading most consistent with the original task, state the assumption, proceed.";
  }

  // safe: giữ hành vi cũ — chỉ cảnh báo mập mờ, không tự quyết thay người.
  const answers = await askJev(key, state, {
    ambiguous: { type: "boolean", safe: true, instructions: { question: "Does the latest prompt read as ambiguous?", focus: FOCUS }, criteria: AMBIGUOUS },
  }, "gate:prompt", 4000, sizes).catch(() => null);
  const p = answers?.ambiguous?.probability;
  if (p === undefined) return null;
  const label = p >= 0.85 ? "ambiguous" : "clear";
  logEvent({
    kind: "decision", source: "hook", gate: "prompt", session_id: input.session_id, outcome: label,
    question: truncate(prompt, 4_000), label, confidence: label === "ambiguous" ? p : 1 - p, reason: truncate(AMBIGUOUS[label === "ambiguous"], 160),
  });
  return label === "ambiguous" ? "Jev: this request reads as ambiguous — ask one clarifying question before acting." : null;
}

async function main() {
  const input = readStdinJson();
  const lines = [];
  if (env("REMIND") !== "0" && apiKey()) lines.push(REMINDER);
  if (input) {
    const warning = await judgePrompt(input);
    if (warning) lines.push(warning);
  }
  if (lines.length === 0) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
  }));
}

main().catch(() => {});
