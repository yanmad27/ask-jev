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
const MAX_QUESTIONS = 10;
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

// Claude Code ≥ 2.1.284 (S0): tool_response là object {questions, answers:{<câu hỏi>:<nhãn | [nhãn] | "A, B">}, annotations}.
const isAnswersMap = (r) => r && typeof r === "object" && !Array.isArray(r) && r.answers && typeof r.answers === "object" && !Array.isArray(r.answers);

function extractChoices(raw) {
  if (isAnswersMap(raw)) {
    return Object.entries(raw.answers)
      .filter(([, v]) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")))
      .map(([question, answer]) => ({ question, answer, prefixKind: undefined }));
  }
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

// Kênh annotate: PreToolUse đổi văn bản câu hỏi thành `${gốc}\n\n[i/n] ${advice_text}` (n chỉ có khi > 1 câu). Dựng lại
// đúng chuỗi đó từ dòng advice — khớp theo KHÓA CHÍNH XÁC (gốc hoặc bản chú thích đó), không bao giờ theo tiền tố.
function suffixFor(index, total, row) {
  const shown = row?.outcome === "advised" || (row?.outcome === "advice_unavailable" && row.note_shown === true);
  return shown && typeof row.advice_text === "string" ? `\n\n${total > 1 ? `[${index + 1}/${total}] ` : ""}${row.advice_text}` : null;
}

/** Câu hỏi GỐC của PreToolUse (tool_input có thể đã bị chú thích) + mọi khóa mà Claude Code có thể dùng làm key của answers. */
function questionKeys(index, total, row, toolQuestion, responseQuestion) {
  const suffix = suffixFor(index, total, row);
  const givens = [toolQuestion?.question, responseQuestion].filter((g) => typeof g === "string");
  const stripped = suffix ? givens.find((g) => g.endsWith(suffix)) : undefined;
  let original = stripped !== undefined ? stripped.slice(0, -suffix.length) : givens[0];
  if (original === undefined && typeof row?.question === "string" && row.question.length < 300) original = row.question;
  const keys = new Set(givens);
  if (original !== undefined) {
    keys.add(original);
    if (suffix) keys.add(original + suffix);
  }
  return { original, keys };
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
    const respQuestions = Array.isArray(input.tool_response?.questions) ? input.tool_response.questions : [];
    // AskUserQuestion có tối đa vài câu: chặn trên để một tool_input/log thù địch không biến vòng lặp thành vô hạn.
    const total = Math.min(MAX_QUESTIONS, Math.max(respQuestions.length, toolQuestions.length, ...[...rows.keys()].map((i) => i + 1)));
    const claimed = new Set();
    const shape = responseShape(input.tool_response);

    const emit = (index, canonical, toolQuestion, row, answer, prefixKind) => {
      const options = Array.isArray(toolQuestion?.options) ? toolQuestion.options.map((o) => o?.label) : (row?.options ?? []);
      const advised = row?.outcome === "advised";
      const base = {
        kind: "outcome", source: "hook", cwd: input.cwd, ...(index !== null ? { question_index: index } : {}),
        question: canonical, options, advice_shown: advised,
        recommended: advised ? row.recommended : null, recommended_confidence: advised ? row.confidence : null,
      };
      if (answer === undefined) {
        logEvent({ ...base, kind_of_answer: "unparsed", chosen: [], agreement: "unparsed", response_shape: shape });
        return;
      }
      const multiSelect = Array.isArray(answer) || Boolean(toolQuestion?.multiSelect) || (advised && row.recommended.length !== 1);
      const chosen = Array.isArray(answer) ? answer : multiSelect ? splitMulti(answer, options) : [answer];
      // Khi biết danh sách option: chosen không nằm trong đó nghĩa là người gõ tự do (chọn "Other"), dù prefix của cả response nói gì.
      const kind = options.length > 0 ? (chosen.every((x) => options.includes(x)) ? "option" : "free_text") : (prefixKind ?? "option");
      logEvent({ ...base, chosen, kind_of_answer: kind, agreement: agreementOf({ kind, recommended: base.recommended, chosen, multiSelect }) });
    };

    // Mỗi câu hỏi mong đợi (theo advice row / tool_input) ra đúng một dòng outcome: có đáp án khớp thì ghi lựa chọn, không thì "unparsed".
    for (let i = 0; i < total; i++) {
      const toolQuestion = toolQuestions[i] ?? respQuestions[i];
      const row = rows.get(i);
      const { original, keys } = questionKeys(i, total, row, toolQuestion, respQuestions[i]?.question);
      const at = choices.findIndex((c, k) => !claimed.has(k) && keys.has(c.question));
      if (at >= 0) claimed.add(at);
      emit(i, original ?? row?.question ?? "", toolQuestion, row, at >= 0 ? choices[at].answer : undefined, at >= 0 ? choices[at].prefixKind : undefined);
    }
    // Đáp án không khớp câu nào đã biết (hoặc không có câu nào để so): vẫn ghi, không gắn chỉ số.
    choices.forEach((c, k) => {
      if (!claimed.has(k)) emit(null, c.question, undefined, undefined, c.answer, c.prefixKind);
    });
    if (total === 0 && choices.length === 0) emit(null, "", undefined, undefined, undefined);
  });
}

try { main(); } catch {}
