#!/usr/bin/env node
/** PostToolUse (AskUserQuestion): ghi lại người dùng thực sự chọn gì — bằng chứng mạnh nhất về preference. */
import { apiKey, logEvent } from "../lib/jev.mjs";
import { readStdinJson, truncate } from "../lib/gate.mjs";

// tool_response thật là string, xác nhận từ transcript thật trên máy — hai dạng Claude Code
// tự viết. "Your questions have been answered" = chọn option; "The user answered" = gõ tự do
// (vd chọn "Other"). Không khớp prefix nào (deny của chính mình, permission bị huỷ, …) thì bỏ qua.
const PREFIXES = [
  { re: /^Your questions have been answered:/, kind: "option" },
  { re: /^The user answered:/, kind: "free_text" },
];
const unescape = (s) => s.replace(/\\(.)/g, "$1");

// Content-block-array form (same shape lib/context.mjs's textOf() flattens from transcript rows) —
// tool_response.content can arrive as [{type:"text", text:"..."}] instead of a plain string.
function flattenParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

function responseText(r) {
  if (typeof r === "string") return r;
  if (!r || typeof r !== "object") return "";
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) return flattenParts(r.content);
  if (typeof r.text === "string") return r.text;
  return "";
}

function extractChoices(raw) {
  const text = responseText(raw);
  const prefix = PREFIXES.find((p) => p.re.test(text));
  if (!prefix) return [];
  const out = [];
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = pair.exec(text))) out.push({ question: unescape(m[1]), chosen: [unescape(m[2])], kind_of_answer: prefix.kind });
  return out;
}

function main() {
  if (!apiKey()) return;
  const input = readStdinJson();
  if (!input || input.tool_name !== "AskUserQuestion") return;
  for (const c of extractChoices(input.tool_response)) {
    logEvent({
      kind: "user_choice", session_id: input.session_id, cwd: input.cwd,
      question: truncate(c.question, 120), chosen: c.chosen, kind_of_answer: c.kind_of_answer,
    });
  }
}

try { main(); } catch {}
