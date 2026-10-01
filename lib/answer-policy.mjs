/**
 * Chính sách trả lời AskUserQuestion: xây payload gửi Jev (request), rồi diễn giải answers
 * Jev trả về thành quyết định (interpretation). Tách khỏi hooks/ask-jev.mjs để Paseo plugin
 * dùng lại được cùng chính sách mà không phải gọi qua hook — module này không fetch, không
 * đọc biến môi trường, không log, không đọc stdin/stdout; mọi thứ là tham số tường minh.
 *
 * Taste rule: destructive luôn defer trước tiên. Với câu personal ở autonomy "safe", defer
 * luôn. Ở "full", `grounded` (bằng chứng thật từ người dùng, không phải sở thích chung chung
 * mà Jev tự đoán) phải đạt threshold CÙNG với độ tin của lựa chọn thì mới trả lời; không thì
 * defer với outcome "ungrounded_personal".
 */
import { DESTRUCTIVE, FOCUS } from "./gate.mjs";

const DESTRUCTIVE_QUESTION = {
  type: "boolean",
  safe: true,
  instructions: { question: "Is `pendingQuestion` about a destructive/irreversible action?", focus: FOCUS },
  criteria: DESTRUCTIVE,
};

export const PERSONAL_QUESTION = {
  type: "boolean",
  safe: true, // an toàn = để người dùng quyết (p cao); mâu thuẫn phải nghiêng về defer, không auto-answer
  instructions: {
    question: "Is `pendingQuestion` something only the user has standing to answer?",
    // Live-captured evidence (2026-09-28 Paseo smoke test): "which package manager should I use"
    // — with the user having explicitly said "never use npm here" — scored personal 0.64. Being
    // phrased as a choice between labeled options (the AskUserQuestion format itself) isn't what
    // makes something personal; a technical question with a real, evidence-backed answer is posed
    // the same way.
    focus:
      "A matter of personal taste, aesthetics, private priorities, or an irreversible consequence — not merely being phrased as a " +
      "choice between labeled options, which a technical question with a real, evidence-backed answer is posed the same way.",
  },
  criteria: {
    true: "Personal preference, aesthetic choice, a trade-off that depends on private goals, or deleting/sending/publishing something that cannot be undone",
    false: "There is a correct answer derivable from `conversationContext`, established convention, or technical fact — regardless of how the question or its options are phrased",
  },
};

export const GROUNDED_QUESTION = {
  type: "boolean",
  safe: false, // an toàn = ungrounded (defer); mâu thuẫn phải nghiêng về false, không tự tin bừa
  instructions: {
    question: "Do direct user messages or the user's real past choices in `conversationContext` support a specific option for `pendingQuestion`?",
    // Live-captured evidence (2026-09-28 Paseo smoke test): a baseless color-preference question
    // scored grounded 0.86-0.96 — conversationContext happened to contain pendingQuestion's own
    // text/options (from an earlier message describing what to ask later), and the model counted
    // that as evidence. The explicit exclusion below measurably reduced (though didn't eliminate)
    // that false grounding in /tmp/jev-repro-* reruns of the same payload.
    focus:
      "A generic aesthetic prior (e.g. \"most people prefer X\") does not count as grounding — only concrete evidence from this user. " +
      "Neither does `pendingQuestion`'s own wording or `answerOptions`' labels merely appearing somewhere in `conversationContext` " +
      "(e.g. because an earlier message described what to ask later, or is the ask itself) — that's the question being asked, not " +
      "the user expressing a preference. Only an actual stated preference, decision, or past choice counts.",
  },
  criteria: {
    true: "conversationContext contains a direct user statement or a documented past choice pointing to a specific option, independent of the question/options being asked",
    false: "No such evidence exists — support would rest on a generic prior, a guess, the question's own wording/options appearing in context, or the absence of information",
  },
};

/**
 * criteria dạng {what, not_for} theo docs.typesafe.ai/primitives/choice — not_for nêu tên các
 * lựa chọn khác để ép tính loại trừ lẫn nhau. Dùng chung cho cả state.answerOptions lẫn
 * questions.pick.criteria nên tách riêng khỏi buildPickQuestions.
 */
export function pickCriteria(options) {
  return Object.fromEntries(
    options.map((o, i) => [
      `o${i}`,
      {
        what: `${o.label} — ${o.description}`,
        not_for: options.filter((_, j) => j !== i).map((other) => other.label).join(", "),
      },
    ]),
  );
}

export function buildPickQuestions(options, { autonomy }) {
  return {
    pick: {
      type: "choice",
      instructions: {
        question: "Given `conversationContext`, which option answers `pendingQuestion`? Acting on the user's behalf, which would they pick?",
        focus:
          "Each option's `what` in `answerOptions` is its definition, `not_for` is what it must not overlap with. Choose what the user themselves would choose.",
      },
      criteria: pickCriteria(options),
    },
    personal: PERSONAL_QUESTION,
    destructive: DESTRUCTIVE_QUESTION,
    ...(autonomy === "full" ? { grounded: GROUNDED_QUESTION } : {}),
  };
}

/**
 * multiSelect: không có một "phương án đúng" duy nhất, nên mỗi option là một câu hỏi boolean
 * riêng — có áp dụng hay không.
 */
export function buildMultiQuestions(question, options, { autonomy }) {
  const questions = { personal: PERSONAL_QUESTION, destructive: DESTRUCTIVE_QUESTION };
  if (autonomy === "full") questions.grounded = GROUNDED_QUESTION;
  options.forEach((o, i) => {
    questions[`o${i}`] = {
      type: "boolean",
      instructions: {
        question: `${question} — does this option apply? Acting on the user's behalf, would they pick it?`,
        focus: `Judge only whether "${o.label}" applies, independent of the other options.`,
      },
      criteria: {
        true: `${o.label} — ${o.description}`,
        false: `Does not apply: ${o.label} — ${o.description} is not the case`,
      },
    };
  });
  return questions;
}

/**
 * Đọc pick từ answers một cách an toàn: thiếu `pick`/`choice`/`probabilities`, hoặc choice
 * trỏ ra ngoài `options`, đều coi là dữ liệu hỏng — trả null để caller defer, không suy đoán
 * confidence hay để `.slice()` ném lỗi.
 */
function readPick(answers, options) {
  const choice = answers.pick?.choice;
  if (typeof choice !== "string") return null;
  const confidence = answers.pick?.probabilities?.[choice];
  if (typeof confidence !== "number") return null;
  const idx = Number.parseInt(choice.slice(1), 10);
  const picked = Number.isInteger(idx) ? options[idx] : undefined;
  if (!picked) return null;
  return { picked, confidence };
}

const REASON_CAP = 160;
const STRENGTH_CUT_DEFAULT = 0.8;

const tagOf = (grounded) => (grounded === null ? "" : grounded >= 0.5 ? "grounded in your messages/past choices" : "no direct statement from you — a guess");

function adviceReason(descriptions, grounded) {
  const tag = tagOf(grounded);
  const body = descriptions.filter(Boolean).join("; ");
  if (!tag) return body.length > REASON_CAP ? `${body.slice(0, REASON_CAP - 1)}…` : body;
  const suffix = ` [${tag}]`;
  const room = REASON_CAP - suffix.length;
  return `${body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body}${suffix}`;
}

const groundedOf = (answers) => (typeof answers.grounded?.probability === "number" ? answers.grounded.probability : null);
const strengthOf = (confidence, threshold) => (confidence >= threshold ? "strong" : "weak");
const unavailable = (reason) => ({ outcome: "advice_unavailable", reason });

/**
 * Advisory: Jev chỉ tư vấn, không bao giờ trả lời/chặn câu hỏi. Chỉ cần câu pick (hoặc o0..oN) và
 * `grounded` — destructive/personal không còn vai trò chặn (người dùng luôn là người quyết), nên bỏ khỏi payload.
 */
export function buildAdviceQuestions(options) {
  return { pick: buildPickQuestions(options, { autonomy: "full" }).pick, grounded: GROUNDED_QUESTION };
}

export function buildAdviceMultiQuestions(question, options) {
  const { personal, destructive, ...rest } = buildMultiQuestions(question, options, { autonomy: "full" });
  return rest;
}

/** Điều kiện chặn từ phía input: không có gì để so sánh, hoặc option thiếu mô tả (Jev không có định nghĩa để chấm). */
export function adviceBlocker(options) {
  if (!Array.isArray(options) || options.length < 2) return "single_option";
  if (options.some((o) => typeof o?.description !== "string" || !o.description.trim())) return "missing_definition";
  return null;
}

/**
 * Single-pick → {outcome:"advised", pick:<label>, recommended:[label], confidence, strength, grounded:number|null, reason}
 * hoặc {outcome:"advice_unavailable", reason:"parse_error"}. Không bao giờ có outcome khiến câu hỏi bị trả lời/chặn.
 * `reason` = mô tả của chính option + tag grounded (classifier không trả lời giải thích).
 */
export function interpretAdvice(answers, options, { threshold = STRENGTH_CUT_DEFAULT } = {}) {
  const result = readPick(answers ?? {}, options);
  if (!result) return unavailable("parse_error");
  const { picked, confidence } = result;
  const grounded = groundedOf(answers);
  return {
    outcome: "advised",
    pick: picked.label,
    recommended: [picked.label],
    confidence,
    strength: strengthOf(confidence, threshold),
    grounded,
    reason: adviceReason([picked.description], grounded),
  };
}

/** multiSelect: option nào p >= 0.5 thì được đề xuất (có thể rỗng); confidence = độ dứt khoát thấp nhất giữa các option. */
export function interpretMultiAdvice(answers, options, { threshold = STRENGTH_CUT_DEFAULT } = {}) {
  const selected = [];
  const descriptions = [];
  let confidence = 1;
  for (let i = 0; i < options.length; i++) {
    const p = answers?.[`o${i}`]?.probability;
    if (typeof p !== "number") return unavailable("parse_error");
    if (p >= 0.5) {
      selected.push(options[i].label);
      descriptions.push(options[i].description);
    }
    confidence = Math.min(confidence, Math.max(p, 1 - p));
  }
  const grounded = groundedOf(answers);
  return {
    outcome: "advised",
    pick: selected,
    recommended: selected,
    confidence,
    strength: strengthOf(confidence, threshold),
    grounded,
    reason: adviceReason(descriptions.length ? descriptions : ["no option applies"], grounded),
  };
}

/**
 * Nhiều câu hỏi, mỗi câu một kết quả riêng: items = [{options, multiSelect, answers, errorClass?}] (answers null/undefined = provider lỗi
 * cho câu đó). Câu lỗi → advice_unavailable{reason: errorClass ?? "provider_error"}; câu khác vẫn có advice bình thường.
 */
export function adviseQuestions(items, { threshold = STRENGTH_CUT_DEFAULT } = {}) {
  return items.map(({ options, multiSelect, answers, errorClass }) => {
    const blocked = adviceBlocker(options);
    if (blocked) return unavailable(blocked);
    if (!answers) return unavailable(errorClass ?? "provider_error");
    return multiSelect ? interpretMultiAdvice(answers, options, { threshold }) : interpretAdvice(answers, options, { threshold });
  });
}
