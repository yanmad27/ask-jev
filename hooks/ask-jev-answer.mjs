#!/usr/bin/env node
/**
 * PostToolUse (AskUserQuestion): ghi lại người dùng thực sự chọn gì, cạnh đề xuất của Jev (nếu có) —
 * dòng `outcome` nối với dòng advice của PreToolUse qua invocation_id = tool_use_id.
 * Không parse được tool_response thì vẫn ghi `kind_of_answer:"unparsed"`, không bao giờ bỏ rơi im lặng.
 */
import { readFileSync } from "node:fs";
import { apiKey, logEvent, logFilePath, runInvocation } from "../lib/jev.mjs";
import { readStdinJson } from "../lib/gate.mjs";
import { env } from "../lib/env.mjs";

// tool_response thật là string, xác nhận từ transcript thật trên máy — hai dạng Claude Code
// tự viết. "Your questions have been answered" = chọn option; "The user answered" = gõ tự do
// (vd chọn "Other"). Tài liệu chính thức không đặc tả shape này — không khớp thì ghi "unparsed".
const PREFIXES = [
  { re: /^Your questions have been answered:/, kind: "option" },
  { re: /^The user answered:/, kind: "free_text" },
];
const THRESHOLD = Number.isFinite(Number(env("ASK_THRESHOLD", 0.8))) ? Number(env("ASK_THRESHOLD", 0.8)) : 0.8;
const unescape = (s) => s.replace(/\\(.)/g, "$1");

// Content-block-array form (same shape lib/context.mjs's textOf() flattens from transcript rows) —
// tool_response.content can arrive as [{type:"text", text:"..."}] instead of a plain string.
function flattenParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

function responseText(r) {
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return flattenParts(r);
  if (!r || typeof r !== "object") return "";
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) return flattenParts(r.content);
  if (typeof r.text === "string") return r.text;
  return "";
}

/** Chỉ tên khóa/kiểu, không nội dung — để biết shape thật của tool_response khi không parse được. */
function responseShape(r) {
  if (r === null || r === undefined) return String(r);
  if (typeof r !== "object") return typeof r;
  return `${Array.isArray(r) ? "array" : "object"}:${Object.keys(r).slice(0, 10).join(",")}`;
}

function extractChoices(raw) {
  const text = responseText(raw);
  const prefix = PREFIXES.find((p) => p.re.test(text));
  if (!prefix) return [];
  const out = [];
  const pair = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = pair.exec(text))) out.push({ question: unescape(m[1]), answer: unescape(m[2]), prefixKind: prefix.kind });
  return out;
}

/** Dòng advice (decision gate:"ask") của invocation này, theo question_index. Đọc đuôi log, bản ghi mới nhất thắng. */
function adviceRows(invocationId) {
  const byIndex = new Map();
  if (!invocationId) return byIndex;
  let lines;
  try {
    lines = readFileSync(logFilePath(), "utf8").split("\n");
  } catch {
    return byIndex;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(invocationId)) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.kind !== "decision" || e.gate !== "ask" || e.invocation_id !== invocationId || !Number.isInteger(e.question_index)) continue;
    if (!["advised", "advice_unavailable"].includes(e.outcome) || byIndex.has(e.question_index)) continue;
    byIndex.set(e.question_index, e);
  }
  return byIndex;
}

const stripEllipsis = (s) => (typeof s === "string" ? s.replace(/…$/, "") : "");
// Câu hỏi có thể đã được chú thích bởi PreToolUse (kênh annotate): bản chú thích = bản gốc + "\n\n" + dòng đề xuất.
const sameQuestion = (key, original) => Boolean(original) && (key === original || key.startsWith(`${original}\n`));

function indexOfQuestion(key, position, toolQuestions, rows) {
  const t = toolQuestions.findIndex((q) => sameQuestion(key, q?.question));
  if (t >= 0) return t;
  for (const [i, row] of rows) {
    const original = stripEllipsis(row.question);
    if (key === row.question || (original && key.startsWith(original))) return i;
  }
  return position < toolQuestions.length || rows.has(position) ? position : null;
}

/** Tách "A, B" của multiSelect về các nhãn đã biết (nhãn có thể chứa ", "); phần không khớp giữ nguyên làm một mục. */
function splitMulti(answer, labels) {
  const known = new Set(labels);
  const tokens = answer.split(", ");
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    let j = tokens.length;
    while (j > i + 1 && !known.has(tokens.slice(i, j).join(", "))) j--;
    out.push(tokens.slice(i, j).join(", "));
    i = j;
  }
  return out;
}

function agreementOf({ kind, recommended, chosen, multiSelect }) {
  if (kind === "free_text") return "free_text";
  if (!Array.isArray(recommended)) return "no_advice";
  const rec = new Set(recommended);
  const cho = new Set(chosen);
  const same = rec.size === cho.size && [...cho].every((c) => rec.has(c));
  if (same) return "agree";
  if (multiSelect && [...cho].some((c) => rec.has(c))) return "partial";
  return "disagree";
}

function main() {
  if (!apiKey()) return;
  const input = readStdinJson();
  if (!input || input.tool_name !== "AskUserQuestion") return;

  const invocationId = input.tool_use_id || undefined;
  const ctx = { invocation_id: invocationId, session_id: input.session_id ?? null, source: "hook", threshold: THRESHOLD };
  runInvocation(ctx, () => {
    const toolQuestions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
    const rows = adviceRows(invocationId);
    const choices = extractChoices(input.tool_response);

    if (choices.length === 0) {
      logEvent({
        kind: "outcome", source: "hook", cwd: input.cwd, kind_of_answer: "unparsed", chosen: [], advice_shown: [...rows.values()].some((r) => r.outcome === "advised"),
        recommended: null, recommended_confidence: null, agreement: "unparsed", response_shape: responseShape(input.tool_response),
      });
      return;
    }

    choices.forEach((c, position) => {
      const index = indexOfQuestion(c.question, position, toolQuestions, rows);
      const row = index === null ? undefined : rows.get(index);
      const toolQuestion = index === null ? undefined : toolQuestions[index];
      const options = Array.isArray(toolQuestion?.options) ? toolQuestion.options.map((o) => o?.label) : (row?.options ?? []);
      const multiSelect = Boolean(toolQuestion?.multiSelect) || (Array.isArray(row?.recommended) && row.recommended.length !== 1);
      const chosen = multiSelect ? splitMulti(c.answer, options) : [c.answer];
      // Khi biết danh sách option: chosen không nằm trong đó nghĩa là người gõ tự do (chọn "Other"), dù prefix của cả response nói gì.
      const kind = options.length > 0 ? (chosen.every((x) => options.includes(x)) ? "option" : "free_text") : c.prefixKind;
      const advised = row?.outcome === "advised";
      logEvent({
        kind: "outcome", source: "hook", cwd: input.cwd,
        ...(index !== null ? { question_index: index } : {}),
        question: sameQuestion(c.question, toolQuestion?.question) ? toolQuestion.question : c.question,
        options, chosen, kind_of_answer: kind, advice_shown: advised,
        recommended: advised ? row.recommended : null,
        recommended_confidence: advised ? row.confidence : null,
        agreement: agreementOf({ kind, recommended: advised ? row.recommended : null, chosen, multiSelect }),
      });
    });
  });
}

try { main(); } catch {}
