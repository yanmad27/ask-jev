#!/usr/bin/env node
/**
 * Hỏi Jev trước khi hỏi người.
 *
 * Chặn AskUserQuestion, đưa câu hỏi + ngữ cảnh phiên cho Jev (typesafe.ai, model
 * đánh giá trả xác suất). Đủ chắc và không phải chuyện riêng của người dùng thì
 * trả lời thay, còn lại để câu hỏi đi tiếp bình thường.
 *
 * Claude Code không cho hook trả về tool result giả, nhưng permissionDecision
 * "deny" thì permissionDecisionReason được đưa ngược vào model — nên "trả lời"
 * ở đây = chặn câu hỏi + nói cho model biết đáp án.
 *
 * Không phụ thuộc npm: chỉ fetch + fs của Node.
 */
import { readFileSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { apiKey, askJev, logEvent } from "../lib/jev.mjs";
import { buildState, hasContext } from "../lib/context.mjs";
import { truncate, autonomy } from "../lib/gate.mjs";
import { env } from "../lib/env.mjs";
import { buildPickQuestions, buildMultiQuestions, interpretPick, interpretMulti, pickCriteria } from "../lib/answer-policy.mjs";

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

const THRESHOLD = Number(env("ASK_THRESHOLD", 0.8));

let currentSessionId;
function logDecision(question, options, outcome, extra = {}) {
  logEvent({ kind: "decision", source: "hook", gate: "ask", session_id: currentSessionId, question, options: options.map((o) => o.label), outcome, ...extra });
}

/** Log kết quả của answer-policy.mjs rồi trả về {label, confidence} nếu đã trả lời, ngược lại null. */
function applyResult(question, options, result) {
  logDecision(question, options, result.outcome, {
    ...(result.label ? { label: result.label } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.reason ? { reason: truncate(result.reason, 160) } : {}),
  });
  return result.outcome === "answered" ? { label: result.label, confidence: result.confidence } : null;
}

async function decide(key, { question, options, context, sizes }) {
  if (options.length < 2) {
    logDecision(question, options, "error", { reason: "single option" });
    return null;
  }

  const mode = autonomy();
  // docs.typesafe.ai/concepts/state: state là nội dung để đánh giá, tách khỏi câu
  // hỏi (judgment) nằm trong instructions; mỗi phần đặt tên rõ để giữ quan hệ.
  const answers = await askJev(
    key,
    { conversationContext: context, pendingQuestion: question, answerOptions: pickCriteria(options) },
    buildPickQuestions(options, { autonomy: mode }),
    "hook",
    8000,
    sizes,
  );

  return applyResult(question, options, interpretPick(answers, options, { autonomy: mode, threshold: THRESHOLD }));
}

/**
 * multiSelect: không có một "phương án đúng" duy nhất, nên mỗi option là một câu
 * hỏi boolean riêng — có áp dụng hay không. Chỉ giải quyết khi MỌI option đều dứt
 * khoát (>= THRESHOLD hoặc <= 1-THRESHOLD); còn một option lửng lơ ở giữa thì cả
 * câu hỏi coi như chưa giải quyết được, để người quyết.
 */
async function decideMulti(key, { question, options, context, sizes }) {
  if (options.length < 2) {
    logDecision(question, options, "error", { reason: "single option" });
    return null;
  }

  const mode = autonomy();
  const answers = await askJev(
    key,
    { conversationContext: context, pendingQuestion: question },
    buildMultiQuestions(question, options, { autonomy: mode }),
    "hook",
    8000,
    sizes,
  );

  return applyResult(question, options, interpretMulti(answers, options, { autonomy: mode, threshold: THRESHOLD }));
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (input.tool_name !== "AskUserQuestion") return;

  // Trong Paseo, AskUserQuestion là "permission request" native (kind:"question") do
  // người dùng trả lời trên UI. Hook Claude Code chỉ có permissionDecision "deny" để
  // đưa văn bản ngược vào model — Paseo hiển thị "deny" đó thành khối lỗi đỏ
  // "PreToolUse:AskUserQuestion hook error", trông như hỏng dù đáp án của Jev vẫn tới
  // model. Nên trong Paseo hook đứng im: để câu hỏi hiện bình thường cho người dùng,
  // không auto-answer, không lỗi đỏ. PASEO_AGENT_ID chỉ tồn tại trong agent của Paseo.
  if (process.env.PASEO_AGENT_ID) {
    logEvent({ kind: "diagnostic", source: "hook", gate: "ask", session_id: input.session_id, outcome: "paseo_standdown" });
    return;
  }

  if (isDuplicate(input)) return;
  currentSessionId = input.session_id;

  const key = apiKey();
  if (!key) {
    logEvent({ kind: "decision", source: "hook", gate: "ask", session_id: input.session_id, outcome: "no_key" });
    return;
  }

  const questions = input.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return;

  // Jev chấm theo criteria; nhãn trần không có description thì không phải criterion.
  const missing = questions.flatMap((q) =>
    (q.options ?? [])
      .filter((o) => !o.description || !o.description.trim())
      .map((o) => `"${q.question}" → option "${o.label}"`),
  );
  if (missing.length > 0) {
    for (const q of questions) {
      if ((q.options ?? []).some((o) => !o.description || !o.description.trim())) {
        logDecision(q.question, q.options ?? [], "missing_definition");
      }
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Every option needs a description that DEFINES it — that's the criterion Jev scores a probability against, a bare " +
          "label is not one. A usable definition is observable (checkable directly against the conversation, not inferred) and " +
          "mutually exclusive (it could not also describe a different option) — otherwise the probability is meaningless. " +
          'Example: question "Is this a hamburger?" → option "Yes" needs a description like "A hot sandwich: cooked ground-meat ' +
          'patty inside a sliced bun" — checkable, and clearly not what "No" would also satisfy — not just "Yes". ' +
          `Re-ask the same question(s) with every option carrying a definition like that. Missing definitions:\n${missing.join("\n")}`,
        systemMessage: "Jev: options need definitions — asking again",
      },
    }));
    return;
  }

  const { state, sizes } = buildState({ transcriptPath: input.transcript_path ?? "", cwd: input.cwd, sessionId: input.session_id });
  if (!hasContext(state)) {
    logEvent({ kind: "decision", source: "hook", gate: "ask", session_id: input.session_id, outcome: "no_context" });
    return;
  }

  const results = await Promise.all(
    questions.map((q) => {
      const fn = q.multiSelect ? decideMulti : decide;
      return fn(key, { question: q.question, options: q.options ?? [], context: state, sizes }).catch(() => {
        logDecision(q.question, q.options ?? [], "error");
        return null;
      });
    }),
  );

  // Trả lời từng câu một, không phải tất-cả-hoặc-không-gì: câu nào Jev chắc thì
  // dùng luôn, câu nào không thì bảo Claude chỉ hỏi lại đúng câu đó — người dùng
  // không mất những lựa chọn Jev đã chắc chỉ vì một câu khác còn mập mờ.
  const resolved = questions
    .map((q, i) => (results[i]?.label ? { question: q.question, ...results[i] } : null))
    .filter(Boolean);
  if (resolved.length === 0) return;

  // Reason (model-facing) giữ mapping câu hỏi ↔ lựa chọn — nhiều câu trong một request thì
  // Claude cần biết Jev chọn gì cho câu nào. systemMessage (người dùng thấy) thì ngắn, không
  // cần lặp lại câu hỏi.
  const shortLines = resolved.map((r) => `Jev chose "${r.label}" (${r.confidence.toFixed(2)})`);
  const answered = resolved.map((r) => `"${r.question}" → Jev chose "${r.label}" (${r.confidence.toFixed(2)})`).join("\n");
  const unresolved = questions.filter((_, i) => !results[i]?.label).map((q) => `"${q.question}"`);

  // Đây không phải lỗi: Claude Code chỉ có permissionDecision "deny" để đưa văn bản
  // ngược vào model, nên câu trả lời của Jev buộc phải đi qua đường "deny" và UI
  // hiển thị nó dưới nhãn đỏ "hook error". Mở đầu reason bằng "Not a real error" để
  // người liếc qua transcript hiểu ngay đây là câu Jev tự trả lời, không phải hỏng.
  const reason = unresolved.length === 0
    ? `Not a real error — Jev already answered this for you from the conversation, so you don't have to ask. Use these choices and continue; do not re-ask:\n${answered}`
    : `Not a real error — Jev already answered some of these for you from the conversation. Use these, do not re-ask them:\n` +
      `${answered}\n\nRe-ask the user ONLY the unresolved question(s):\n${unresolved.join("\n")}`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      systemMessage: shortLines.join("; "),
    },
  }));
}

// Mọi lỗi đều im lặng: hook này chỉ được phép bớt việc cho người, không bao giờ
// được chặn họ trả lời.
main().catch(() => {});
