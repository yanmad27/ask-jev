#!/usr/bin/env node
/** UserPromptSubmit: nhắc luật hỏi Jev mỗi lượt (thay hooks/remind.mjs cũ) + gắn cảnh báo khi prompt mập mờ. */
import { fileURLToPath } from "node:url";
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate } from "../../lib/gate.mjs";

const jevPath = fileURLToPath(new URL("../../bin/jev.mjs", import.meta.url));
const REMINDER = `Reminder: before classifying / choosing among options / yes-no on evidence, ask Jev: echo '<json>' | node "${jevPath}" (skill ask-jev). Personal taste or irreversible actions → ask the user.`;
const CRITERIA = {
  true: "Multiple materially different readings that would change the work",
  false: "Clear, or trivially disambiguated by the conversation so far",
};

async function ambiguityWarning(input) {
  if (!enabled("prompt")) return null;
  const prompt = input.prompt ?? "";
  if (prompt.length < 12 || prompt.startsWith("/")) return null;

  const state = buildState({ transcriptPath: input.transcript_path, cwd: input.cwd, action: { prompt } });
  if (!hasContext(state)) return null;

  const answers = await askJev(apiKey(), state, {
    ambiguous: {
      type: "boolean",
      instructions: { question: "Does the latest prompt read as ambiguous?", focus: FOCUS },
      criteria: CRITERIA,
    },
  }, "gate:prompt", 4000).catch(() => null);
  if (!answers) return null;

  const p = answers.ambiguous.probability;
  const label = p >= 0.85 ? "ambiguous" : "clear";
  logEvent({
    kind: "decision", source: "hook", gate: "prompt", outcome: label,
    question: truncate(prompt, 120), label, confidence: label === "ambiguous" ? p : 1 - p, reason: truncate(CRITERIA[label === "ambiguous"], 160),
  });
  return label === "ambiguous" ? "Jev: this request reads as ambiguous — ask one clarifying question before acting." : null;
}

async function main() {
  const input = readStdinJson();
  const lines = [];
  if (process.env.JEV_REMIND !== "0" && apiKey()) lines.push(REMINDER);
  if (input) {
    const warning = await ambiguityWarning(input);
    if (warning) lines.push(warning);
  }
  if (lines.length === 0) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") },
  }));
}

main().catch(() => {});
