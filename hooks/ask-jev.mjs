#!/usr/bin/env node
/**
 * Jev tư vấn trước khi người trả lời AskUserQuestion.
 *
 * Hook này KHÔNG BAO GIỜ trả lời hay chặn câu hỏi: không permissionDecision "deny"/"allow",
 * không `answers`/`response` trong updatedInput. Nó hỏi Jev với ngữ cảnh phiên rồi hiện đề xuất
 * (option, độ chắc, một dòng lý do) cho người; lỗi provider thì hiện ghi chú "không có đề xuất".
 *
 * Kênh hiển thị (ASK_JEV_ADVICE_CHANNEL):
 *   message  (mặc định) — chỉ `{"systemMessage": ...}` ở top-level; câu hỏi đi nguyên vẹn.
 *   annotate            — hookSpecificOutput {permissionDecision:"ask", updatedInput:{...tool_input, questions đã chú thích}}
 *                         + cùng systemMessage; câu hỏi chú thích thêm đề xuất, option được đề xuất đánh dấu "(Jev đề xuất)".
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

export const adviceChannel = () => (env("ADVICE_CHANNEL", "message")?.trim().toLowerCase() === "annotate" ? "annotate" : "message");

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
const fmtConf = (c) => Number(c).toFixed(2);

/** "Jev đề xuất: X (0.86) — lý do" (chắc) hoặc "Jev nghiêng về: X (0.55) — lý do" (yếu). */
export function adviceLine(advice) {
  const picked = advice.recommended.length ? advice.recommended.map(clean).join(", ") : "không chọn option nào";
  const head = advice.strength === "strong" ? "Jev đề xuất" : "Jev nghiêng về";
  const reason = clean(advice.reason);
  return `${head}: ${picked} (${fmtConf(advice.confidence)})${reason ? ` — ${reason}` : ""}`;
}

/** Ghi chú khi không có đề xuất. `notice` = "billing" chỉ cho lần đầu trong phiên (claimBillingNote), sau đó generic. */
export function unavailableNote(errorClass, status, notice) {
  if (notice === "billing") return "Jev: không có đề xuất (hết credits — credits exhausted) — bạn tự quyết";
  return `Jev: không có đề xuất (lỗi ${status ?? errorClass ?? "provider"}) — bạn tự quyết`;
}

const reasonOf = (errorClass) => (errorClass === "billing" || errorClass === "timeout" ? errorClass : "provider_error");

function annotateQuestions(toolInput, questions, advices, lines) {
  return {
    ...toolInput,
    questions: questions.map((q, i) => {
      const a = advices[i];
      if (a?.outcome !== "advised") return q;
      const recommended = new Set(a.recommended);
      return {
        ...q,
        question: `${q.question}\n\n${lines[i]}`,
        options: (q.options ?? []).map((o) => (recommended.has(o.label) ? { ...o, description: `${o.description} (Jev đề xuất)` } : o)),
      };
    }),
  };
}

async function advise(input, questions, key) {
  const channel = adviceChannel();
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
  const noteFor = (i) => {
    const f = failures.get(i);
    if (!f) return null;
    if (f.errorClass === "billing" && billingShown) return f.notice === "billing" ? unavailableNote(f.errorClass, f.status, "billing") : "";
    return unavailableNote(f.errorClass, f.status, f.notice);
  };
  const display = channel === "annotate" ? "updatedInput" : "systemMessage";

  advices.forEach((a, i) => {
    const q = questions[i];
    if (a.outcome === "advised") {
      row(i, q, "advised", {
        recommended: a.recommended, confidence: a.confidence, strength: a.strength, grounded: a.grounded,
        reason: a.reason, advice_text: lines[i], display,
      });
      return;
    }
    const note = noteFor(i);
    const shown = Boolean(failures.has(i));
    if (note) notes.set(note, withIndex(i, note));
    row(i, q, "advice_unavailable", { reason: a.reason, note_shown: shown });
  });

  const messageLines = advices.flatMap((a, i) => (a.outcome === "advised" ? [withIndex(i, lines[i])] : []));
  const shownNotes = [...notes.values()];
  const systemMessage = [...messageLines, ...shownNotes].join("\n");
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  if (channel === "annotate" && advices.some((a) => a.outcome === "advised")) {
    out.hookSpecificOutput = {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      updatedInput: annotateQuestions(input.tool_input, questions, advices, lines.map((l, i) => (l ? withIndex(i, l) : l))),
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
