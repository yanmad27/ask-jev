#!/usr/bin/env node
/**
 * Jev tư vấn trước khi người trả lời AskUserQuestion.
 *
 * Hook này KHÔNG BAO GIỜ trả lời hay chặn câu hỏi: không permissionDecision "deny"/"allow",
 * không `answers`/`response` trong updatedInput. Nó hỏi Jev với ngữ cảnh phiên rồi hiện đề xuất
 * (option, độ chắc, một dòng lý do) cho người; lỗi provider thì hiện ghi chú "không có đề xuất".
 *
 * Kênh hiển thị (ASK_JEV_ADVICE_CHANNEL):
 *   annotate (mặc định) — hookSpecificOutput {permissionDecision:"ask", updatedInput:{...tool_input, questions đã chú thích}}
 *                         + cùng systemMessage; câu hỏi chú thích thêm đề xuất (hoặc ghi chú "không có đề xuất" khi lỗi),
 *                         option được đề xuất đánh dấu "(Jev đề xuất)". Đây là kênh DUY NHẤT người dùng thấy lúc đang chọn
 *                         (S0, Claude Code 2.1.284): systemMessage chỉ hiện trong transcript sau khi đã trả lời.
 *   message             — chỉ `{"systemMessage": ...}` ở top-level; câu hỏi đi nguyên vẹn.
 *
 * annotate chỉ chạy ở permission_mode default/acceptEdits/plan (hoặc không có); chế độ khác, hoặc văn bản agent chứa dấu hiệu của Jev,
 * thì dùng message. ASK_JEV_FORCE_ANNOTATE=1 là công tắc CHỈ DÙNG ĐỂ KIỂM THỬ (annotate bất kể permission_mode; không có trong README).
 *
 * Im lặng (không note) khi: không có API key, chưa có ngữ cảnh, câu hỏi một option, option thiếu mô tả —
 * hai trường hợp cuối vẫn ghi dòng advice_unavailable{single_option|missing_definition}.
 *
 * Không phụ thuộc npm: chỉ fetch + fs của Node.
 */
import { readFileSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { apiKey, askJev, logEvent, runInvocation, DEFAULT_BUDGET_MS } from "../lib/jev.mjs";
import { buildState, hasContext } from "../lib/context.mjs";
import { env } from "../lib/env.mjs";
import { pickCriteria, buildAdviceQuestions, buildAdviceMultiQuestions, adviceBlocker, adviseQuestions } from "../lib/answer-policy.mjs";

/** Ngân sách gọi provider; hooks.json (10s) và self-register (15s) phải lớn hơn con số này + HOOK_MARGIN_MS. */
export const ADVICE_BUDGET_MS = DEFAULT_BUDGET_MS;

const THRESHOLD = (() => {
  const t = Number(env("ASK_THRESHOLD", 0.8));
  return Number.isFinite(t) ? t : 0.8;
})();

export const adviceChannel = () => (env("ADVICE_CHANNEL", "annotate")?.trim().toLowerCase() === "message" ? "message" : "annotate");

// Văn bản do agent viết: bỏ C0/C1, zero-width, bidi override/isolate, và gộp khoảng trắng/xuống dòng.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;
const clean = (s) => String(s ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();

/**
 * hooks.json và self-register.mjs (xem file đó) có thể cùng đăng ký hook này, nên
 * cùng một câu hỏi tới hai lần cách nhau chưa tới 1s. Lock file theo session + nội
 * dung câu hỏi, còn mới (< 10s) thì coi là bản trùng, im lặng bỏ qua.
 */
function isDuplicate(input) {
  const hash = createHash("sha1").update(JSON.stringify(input.tool_input ?? {})).digest("hex");
  const lockPath = join(tmpdir(), `ask-jev-${input.session_id ?? "x"}-${hash}`);
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
  } catch {}
  try {
    closeSync(openSync(lockPath, "wx"));
    return false;
  } catch {
    return true;
  }
}

const labelsOf = (options) => options.map((o) => o?.label);
// Bằng đúng FIELD_CAP của logEvent: advice_text trong log phải y hệt dòng người dùng thấy, để ask-jev-answer.mjs
// dựng lại được đúng văn bản câu hỏi đã chú thích.
const ADVICE_LINE_CAP = 300;
const fmtConf = (c) => Number(c).toFixed(2);

/**
 * "Lý do" một dòng do CODE sinh ra từ `grounded`, không bao giờ chứa văn bản do agent viết (mô tả option vẫn hiện ngay
 * trên option) — agent không thể giả dòng của Jev bằng cách nhét chữ vào mô tả.
 */
export function groundedTag(grounded) {
  if (typeof grounded !== "number") return "";
  return grounded >= 0.5 ? "[grounded in your messages/past choices]" : "[no direct statement from you — a guess]";
}

/** "Jev đề xuất: X (0.86) — [grounded …]" (chắc) hoặc "Jev nghiêng về: X (0.55) — [grounded …]" (yếu). */
export function adviceLine(advice) {
  const picked = advice.recommended.length ? advice.recommended.map(clean).join(", ") : "không chọn option nào";
  const head = advice.strength === "strong" ? "Jev đề xuất" : "Jev nghiêng về";
  const reason = groundedTag(advice.grounded);
  const line = `${head}: ${picked} (${fmtConf(advice.confidence)})${reason ? ` — ${reason}` : ""}`;
  return line.length > ADVICE_LINE_CAP ? `${line.slice(0, ADVICE_LINE_CAP - 1)}…` : line;
}

/** Ghi chú khi không có đề xuất. `notice` = "billing" chỉ cho lần đầu trong phiên (claimBillingNote), sau đó generic. */
export function unavailableNote(errorClass, status, notice) {
  if (notice === "billing") return "Jev: không có đề xuất (hết credits — credits exhausted) — bạn tự quyết";
  return `Jev: không có đề xuất (lỗi ${status ?? errorClass ?? "provider"}) — bạn tự quyết`;
}

const reasonOf = (errorClass) => (errorClass === "billing" || errorClass === "timeout" ? errorClass : "provider_error");

// updatedInput thay toàn bộ tool_input, nên chỉ ALLOWLIST: `questions` ở top-level; mỗi câu chỉ question/header/multiSelect/options;
// mỗi option chỉ label/description/preview. Mọi khóa khác (answers/response/annotations/picked/… — kể cả input thù địch) bị bỏ,
// nên hook không thể trả lời thay người dùng.
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && Object.hasOwn(obj, k)).map((k) => [k, obj[k]]));

function annotateQuestions(questions, advices, texts) {
  return {
    questions: questions.map((raw, i) => {
      const q = { ...pick(raw, ["question", "header", "multiSelect"]), options: (raw.options ?? []).map((o) => pick(o, ["label", "description", "preview"])) };
      const a = advices[i];
      if (!texts[i]) return q;
      if (a?.outcome !== "advised") return { ...q, question: `${q.question}\n\n${texts[i]}` };
      const recommended = new Set(a.recommended);
      return {
        ...q,
        question: `${q.question}\n\n${texts[i]}`,
        options: q.options.map((o) => (recommended.has(o.label) ? { ...o, description: `${o.description} (Jev đề xuất)` } : o)),
      };
    }),
  };
}

// Kênh annotate (ask + updatedInput) chỉ được xác minh ở chế độ quyền mặc định; chế độ khác (bypassPermissions, dontAsk, …) dùng message.
// ASK_JEV_FORCE_ANNOTATE=1 là công tắc CHỈ DÙNG ĐỂ KIỂM THỬ (không có trong README): annotate bất kể permission_mode, để chạy thật
// xem ask+updatedInput có hiện hộp thoại ở bypassPermissions không.
const ANNOTATE_MODES = new Set(["default", "acceptEdits", "plan"]);
const JEV_MARKERS = ["jev đề xuất", "jev nghiêng về", "jev: không có đề xuất", "[grounded in", "[no direct statement"];

/** Văn bản agent đã chứa dấu hiệu của Jev (giả dòng tư vấn): không chú thích, để người phân biệt được văn bản hook với văn bản agent. */
export function hasJevMarker(questions) {
  const strings = [];
  for (const q of questions) {
    strings.push(q?.question, q?.header);
    for (const o of q?.options ?? []) strings.push(o?.label, o?.description, o?.preview);
  }
  return strings.some((t) => typeof t === "string" && JEV_MARKERS.some((m) => t.toLowerCase().includes(m)));
}

async function advise(input, questions, key) {
  let channel = adviceChannel();
  if (channel === "annotate" && input.permission_mode !== undefined && !ANNOTATE_MODES.has(input.permission_mode) && env("FORCE_ANNOTATE") !== "1") channel = "message";
  if (channel === "annotate" && hasJevMarker(questions)) {
    channel = "message";
    logEvent({ kind: "diagnostic", source: "hook", gate: "ask", outcome: "jev_marker_in_agent_text" });
  }
  const { state, sizes } = buildState({ transcriptPath: input.transcript_path ?? "", cwd: input.cwd, sessionId: input.session_id });
  const row = (i, q, outcome, extra = {}) =>
    logEvent({
      kind: "decision", source: "hook", gate: "ask", mode: "advisory", outcome, question_index: i,
      question: q.question, options: labelsOf(q.options ?? []), ...extra,
    });

  if (!hasContext(state)) {
    questions.forEach((q, i) => row(i, q, "advice_unavailable", { reason: "no_context", note_shown: false }));
    return;
  }

  const failures = new Map();
  const items = await Promise.all(
    questions.map(async (q, i) => {
      const options = q.options ?? [];
      const item = { options, multiSelect: Boolean(q.multiSelect) };
      if (adviceBlocker(options)) return item;
      const [payload, built] = q.multiSelect
        ? [{ conversationContext: state, pendingQuestion: q.question }, buildAdviceMultiQuestions(q.question, options)]
        : [{ conversationContext: state, pendingQuestion: q.question, answerOptions: pickCriteria(options) }, buildAdviceQuestions(options)];
      try {
        item.answers = await askJev(key, payload, built, "hook", ADVICE_BUDGET_MS, sizes, { gate: "ask", question_index: i });
      } catch (err) {
        item.errorClass = reasonOf(err?.errorClass);
        failures.set(i, { errorClass: err?.errorClass, status: err?.status, notice: err?.notice });
      }
      return item;
    }),
  );

  const advices = adviseQuestions(items, { threshold: THRESHOLD });
  const lines = advices.map((a) => (a.outcome === "advised" ? adviceLine(a) : null));
  const multi = questions.length > 1;
  const withIndex = (i, text) => (multi ? `[${i + 1}/${questions.length}] ${text}` : text);

  // Một lỗi provider thường trúng mọi câu: gộp thành một note; billing chỉ hiện đúng một lần (note "billing"
  // thuộc câu nào giành được marker, các câu billing còn lại được note đó che).
  const billingShown = [...failures.values()].some((f) => f.notice === "billing");
  const notes = new Map();
  // Văn bản note của từng câu lỗi: câu billing nào cũng dùng note "credits" khi phiên này đã hiện nó (chỉ in một lần ở systemMessage).
  const noteOf = (i) => {
    const f = failures.get(i);
    if (!f) return null;
    return f.errorClass === "billing" && billingShown ? unavailableNote(f.errorClass, f.status, "billing") : unavailableNote(f.errorClass, f.status, f.notice);
  };
  const noteFor = (i) => {
    const f = failures.get(i);
    if (f?.errorClass === "billing" && billingShown && f.notice !== "billing") return "";
    return noteOf(i);
  };
  const display = channel === "annotate" ? "updatedInput" : "systemMessage";

  advices.forEach((a, i) => {
    const q = questions[i];
    if (a.outcome === "advised") {
      row(i, q, "advised", {
        recommended: a.recommended, confidence: a.confidence, strength: a.strength, grounded: a.grounded,
        reason: groundedTag(a.grounded), advice_text: lines[i], display,
      });
      return;
    }
    const note = noteFor(i);
    const shown = Boolean(failures.has(i));
    if (note) notes.set(note, withIndex(i, note));
    // advice_text = đúng chữ người dùng thấy (ask-jev-answer dựng lại câu hỏi đã chú thích từ đây).
    row(i, q, "advice_unavailable", { reason: a.reason, note_shown: shown, ...(shown ? { advice_text: noteOf(i), display } : {}) });
  });

  const messageLines = advices.flatMap((a, i) => (a.outcome === "advised" ? [withIndex(i, lines[i])] : []));
  const shownNotes = [...notes.values()];
  const systemMessage = [...messageLines, ...shownNotes].join("\n");
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  const texts = advices.map((a, i) => (a.outcome === "advised" ? withIndex(i, lines[i]) : failures.has(i) ? withIndex(i, noteOf(i)) : null));
  if (channel === "annotate" && texts.some(Boolean)) {
    out.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      updatedInput: annotateQuestions(questions, advices, texts),
    };
  }
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (input.tool_name !== "AskUserQuestion") return;

  const ctx = { invocation_id: input.tool_use_id || randomUUID(), session_id: input.session_id ?? null, source: "hook", threshold: THRESHOLD };
  await runInvocation(ctx, async () => {
    // Trong Paseo, AskUserQuestion là permission request native do người dùng trả lời trên UI;
    // Paseo có đường tư vấn riêng, nên hook Claude Code đứng im ở đó. PASEO_AGENT_ID chỉ có trong agent của Paseo.
    if (process.env.PASEO_AGENT_ID) {
      logEvent({ kind: "standdown", source: "hook", gate: "ask", reason: "paseo" });
      return;
    }

    if (isDuplicate(input)) return;

    const key = apiKey();
    if (!key) {
      logEvent({ kind: "decision", source: "hook", gate: "ask", mode: "advisory", outcome: "advice_unavailable", reason: "no_key", note_shown: false });
      return;
    }

    const questions = input.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return;
    await advise(input, questions, key);
  });
}

// Mọi lỗi đều im lặng: hook này chỉ được phép thêm thông tin, không bao giờ được chặn người trả lời.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {});
