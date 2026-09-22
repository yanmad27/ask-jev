#!/usr/bin/env node
/** PostToolUse (AskUserQuestion): ghi lại người dùng thực sự chọn gì — bằng chứng mạnh nhất về preference. */
import { apiKey, logEvent } from "../lib/jev.mjs";
import { readStdinJson, truncate } from "../lib/gate.mjs";

// Shape thật của tool_response cho AskUserQuestion chưa xác nhận được (không có trong docs
// công khai lẫn strings của binary CLI) — thử vài dạng hợp lý; không khớp thì ghi debug để
// soi sau thay vì âm thầm mất evidence. Xoá dòng debug khi đã xác nhận được shape thật.
function extractChoices(r) {
  const rows = Array.isArray(r) ? r
    : r && typeof r === "object" ? Object.entries(r).map(([q, a]) => ({ question: q, ...(a && typeof a === "object" ? a : { answer: a }) }))
    : [];
  return rows
    .map((x) => ({ question: x.question ?? x.header ?? "", chosen: [].concat(x.answer ?? x.answers ?? x.selectedOptions ?? x.selected ?? []).filter(Boolean).map(String) }))
    .filter((x) => x.question || x.chosen.length > 0);
}

function main() {
  if (!apiKey()) return;
  const input = readStdinJson();
  if (!input || input.tool_name !== "AskUserQuestion") return;
  const questions = input.tool_input?.questions ?? [];
  const choices = extractChoices(input.tool_response);
  if (choices.length === 0) {
    logEvent({ kind: "debug", note: "AskUserQuestion tool_response shape unrecognized", sample: truncate(JSON.stringify(input.tool_response ?? null), 500) });
    return;
  }

  for (const c of choices) {
    const q = questions.find((qq) => qq.question === c.question);
    logEvent({
      kind: "user_choice", session_id: input.session_id, cwd: input.cwd,
      question: truncate(c.question, 120), options: (q?.options ?? []).map((o) => o.label), chosen: c.chosen,
    });
  }
}

try { main(); } catch {}
