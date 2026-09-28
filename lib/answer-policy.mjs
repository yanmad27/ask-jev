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
    focus: "A matter of personal taste, aesthetics, private priorities, or an irreversible consequence.",
  },
  criteria: {
    true: "Personal preference, aesthetic choice, a trade-off that depends on private goals, or deleting/sending/publishing something that cannot be undone",
    false: "There is a correct answer derivable from `conversationContext`, established convention, or technical fact",
  },
};

export const GROUNDED_QUESTION = {
  type: "boolean",
  safe: false, // an toàn = ungrounded (defer); mâu thuẫn phải nghiêng về false, không tự tin bừa
  instructions: {
    question: "Do direct user messages or the user's real past choices in `conversationContext` support a specific option for `pendingQuestion`?",
    focus: "A generic aesthetic prior (e.g. \"most people prefer X\") does not count as grounding — only concrete evidence from this user.",
  },
  criteria: {
    true: "conversationContext contains a direct user statement or a documented past choice pointing to a specific option",
    false: "No such evidence exists — support would rest on a generic prior, a guess, or the absence of information",
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

/** Diễn giải answers cho decide() (single-pick). Trả {outcome:"answered", label, confidence, reason}
 * hoặc {outcome: "destructive"|"personal"|"ungrounded_personal"|"low_confidence"|"error", confidence?}.
 * Fail-closed: field bắt buộc thiếu/hỏng (personal, pick/choice/probabilities, grounded khi cần) luôn
 * defer — không bao giờ suy ra một giá trị mặc định khiến câu hỏi bị tự trả lời oan. */
export function interpretPick(answers, options, { autonomy, threshold }) {
  if ((answers.destructive?.probability ?? 1) >= 0.6) return { outcome: "destructive" };

  // Thiếu personal → coi như CÓ (an toàn hơn tự trả lời oan một câu có thể là taste).
  const personalP = answers.personal?.probability ?? 1;
  const isPersonal = personalP > 0.5;
  if (isPersonal && autonomy !== "full") return { outcome: "personal" };

  let groundedP;
  if (isPersonal) {
    groundedP = answers.grounded?.probability;
    if (typeof groundedP !== "number") return { outcome: "error" };
  }

  const result = readPick(answers, options);
  if (!result) return { outcome: "error" };
  const { picked, confidence } = result;

  if (isPersonal) {
    if (groundedP < threshold || confidence < threshold) {
      return { outcome: "ungrounded_personal", confidence: Math.min(groundedP, confidence) };
    }
  } else if (confidence < threshold) {
    return { outcome: "low_confidence", confidence };
  }

  return { outcome: "answered", label: picked.label, confidence, reason: picked.description ?? "" };
}

/** Diễn giải answers cho decideMulti(). Giải quyết chỉ khi MỌI option đều dứt khoát
 * (>= threshold hoặc <= 1-threshold); một option lửng lơ giữa hai ngưỡng, hoặc thiếu hẳn,
 * → chưa giải quyết được (error). Cùng nguyên tắc fail-closed như interpretPick. */
export function interpretMulti(answers, options, { autonomy, threshold }) {
  if ((answers.destructive?.probability ?? 1) >= 0.6) return { outcome: "destructive" };

  const personalP = answers.personal?.probability ?? 1;
  const isPersonal = personalP > 0.5;
  if (isPersonal && autonomy !== "full") return { outcome: "personal" };

  if (isPersonal) {
    const groundedP = answers.grounded?.probability;
    if (typeof groundedP !== "number") return { outcome: "error" };
    if (groundedP < threshold) return { outcome: "ungrounded_personal", confidence: groundedP };
  }

  const selected = [];
  const reasons = [];
  let confidence = 1;
  for (let i = 0; i < options.length; i++) {
    const p = answers[`o${i}`]?.probability;
    if (typeof p !== "number") return { outcome: "error" };
    if (p >= threshold) {
      selected.push(options[i].label);
      reasons.push(options[i].description);
      confidence = Math.min(confidence, p);
    } else if (p <= 1 - threshold) {
      confidence = Math.min(confidence, 1 - p);
    } else {
      return { outcome: "low_confidence", confidence: p };
    }
  }

  const label = selected.length > 0 ? selected.join(", ") : "none";
  const reason = reasons.length > 0 ? reasons.join("; ") : "no option applied";
  return { outcome: "answered", label, confidence, reason };
}
