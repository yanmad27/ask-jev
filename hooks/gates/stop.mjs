#!/usr/bin/env node
/** Stop: Jev chặn dừng sớm khi việc chưa xong; full autonomy còn tự trả lời câu hỏi cuối cùng thay người. */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKey, askJev, logEvent } from "../../lib/jev.mjs";
import { buildState, hasContext } from "../../lib/context.mjs";
import { enabled, readStdinJson, FOCUS, truncate, autonomy } from "../../lib/gate.mjs";

const INCOMPLETE = { true: "Promised something not delivered, left a TODO, or ignored part of the request",
  false: "Complete, or explicitly handed back to the user with a question or blocker" };
const MAX_AUTO_CONTINUE = 3;

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

// Trần auto-continue liên tiếp — không thì Claude kết mỗi lượt bằng một câu hỏi và bị block lại mãi mãi.
const countPath = (id) => join(tmpdir(), `ask-jev-stop-count-${id ?? "x"}`);
const readCount = (id) => { try { return Number(readFileSync(countPath(id), "utf8")) || 0; } catch { return 0; } };
const writeCount = (id, n) => { try { writeFileSync(countPath(id), String(n)); } catch {} };

async function main() {
  if (!enabled("stop")) return;
  const input = readStdinJson();
  // stop_hook_active không có trong docs công khai nhưng có trong hooks reference nội bộ
  // của CLI — true khi Claude Code đang tiếp tục sau lần hook này vừa block.
  if (!input || input.stop_hook_active) return;

  const key = apiKey();
  const message = input.last_assistant_message ?? "";
  const { state, sizes } = buildState({ transcriptPath: input.transcript_path, cwd: input.cwd, sessionId: input.session_id, action: { finalAssistantMessage: message } });
  if (!hasContext(state)) return;

  const answers = await askJev(key, state, {
    incomplete: { type: "boolean", instructions: { question: "Did the assistant stop with work still owed, instead of fully addressing the user's request?", focus: FOCUS }, criteria: INCOMPLETE },
  }, "gate:stop", 4000, sizes).catch(() => null);
  const p = answers?.incomplete?.probability;
  if (p === undefined) return;
  const label = p >= 0.5 ? "incomplete" : "complete";
  const base = { kind: "decision", source: "hook", gate: "stop", session_id: input.session_id, question: truncate(message, 120), label, confidence: label === "incomplete" ? p : 1 - p };
  if (p >= 0.85) {
    logEvent({ ...base, outcome: "block", reason: truncate(INCOMPLETE.true, 160) });
    block(`Jev: request looks incomplete (p=${p.toFixed(2)}) — finish it or tell the user what is left.`);
    return;
  }
  logEvent({ ...base, outcome: "ok", reason: truncate(INCOMPLETE[label === "incomplete"], 160) });
  if (autonomy() !== "full") return;
  // full: nếu Claude vừa hỏi xin phép/quyết định, Jev trả lời thay — trừ khi destructive hoặc thật sự chỉ người dùng mới quyết được.
  const asked = await askJev(key, state, {
    asksUser: { type: "boolean", instructions: {
      question: "Does the final assistant message end by asking the user a question or for permission (e.g. 'do you want me to…', 'should I…', 'shall I proceed')?", focus: FOCUS },
      criteria: { true: "Ends with a question or permission request to the user", false: "Does not end with a question — it's a statement, a report, or already proceeding" } },
  }, "gate:stop", 4000, sizes).catch(() => null);
  if ((asked?.asksUser?.probability ?? 0) < 0.8) return;

  const choice = await askJev(key, state, {
    resolve: { type: "choice", instructions: { question: "Acting on the user's behalf, what should happen with the question the assistant just asked?", focus: FOCUS },
      criteria: {
        yes_proceed: { what: "Answerable from the task and context, and not destructive — proceed on the user's behalf", not_for: "no_stop, needs_user" },
        no_stop: { what: "The user's original ask is already satisfied — nothing more to do", not_for: "yes_proceed, needs_user" },
        needs_user: { what: "Destructive/irreversible, or genuinely a matter of the user's own judgement or taste", not_for: "yes_proceed, no_stop" },
      } },
  }, "gate:stop", 4000, sizes).catch(() => null);
  const pick = choice?.resolve?.choice;
  if (!pick) return;
  const cp = choice.resolve.probabilities?.[pick] ?? 1;
  logEvent({ kind: "decision", source: "hook", gate: "stop", session_id: input.session_id, question: truncate(message, 120), outcome: pick, label: pick, confidence: cp });

  if (pick === "yes_proceed" && cp >= 0.8) {
    const n = readCount(input.session_id) + 1;
    writeCount(input.session_id, n > MAX_AUTO_CONTINUE ? 0 : n);
    if (n <= MAX_AUTO_CONTINUE) block(`Jev answered your question: proceed with "${truncate(message, 160)}". Do not ask again.`);
  } else {
    writeCount(input.session_id, 0);
  }
}

main().catch(() => {});
