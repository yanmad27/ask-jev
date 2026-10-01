/**
 * Kiểm bằng chứng cho CLI `bin/jev.mjs` (ngoài kiểm cấu trúc của requestError): CLI chỉ dành cho phán đoán
 * nội bộ của agent. Toàn bộ là regex xác định, không gọi model — có false positive nên các lớp heuristic
 * yếu chỉ "flag". Reject không có đường hạ cấp: agent tự đặt env được thì luật vô nghĩa — nếu bị reject nhầm
 * thì agent tự chọn thủ công. Câu hỏi/nhãn lựa chọn là thứ bị quét để tìm hành động/gu; hành động/gu chỉ tìm trong
 * thứ Jev được yêu cầu quyết định (câu hỏi, nhãn, định nghĩa criteria), không tìm trong text bằng chứng trong state
 * (brief, report, diff); state chỉ bị soi khoá mô tả người dùng/output của chính agent (đệ quy) và văn xuôi mô tả
 * gu người dùng (flag). Mọi regex chạy trên chuỗi đã cắt (SLICE) và có giới hạn lặp để không bị quadratic.
 */
const SLICE = 4096;
const MAX_DEFINITION = 4096; // câu hỏi/focus/định nghĩa criteria dài hơn mức này bị reject — nếu chỉ cắt thì padding giấu được câu hỏi quyết định
const MAX_STRINGS = 2000;
const MAX_DEPTH = 8;
const cut = (s) => (s.length > SLICE ? s.slice(0, SLICE) : s);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Khoá state chứa bằng chứng theo cấu trúc (lời người dùng, output lệnh, file) — không phải mô tả của agent.
const CARRIER_KEY = /^(user_messages|user_said|messages|quotes|past_choices|transcript|verbatim|output|stdout|stderr|command_output|files|diff)$/i;
const USER_WORDS_KEY = /^(user_messages|user_said|quotes|past_choices|messages)$/i;
const COMMAND_OUTPUT_KEY = /^(command_output|stdout|stderr|output)$/i;
const USER_DESCRIPTION_KEY = /^(user_?(profile|style|taste|prefs?|preferences?|persona|likes?|wants?|description)|about_?user|persona)$/i;
const SELF_OUTPUT_KEY = /^(my|agent|assistant|own)_?(output|answer|code|summary|work|solution)/i;

const USER_DESCRIPTION_TEXT = /\b(?:(?:the|this|our) users?|users?(?=\s+(?:probably|likely|seems?|tends?|usually|typically)))\b[^.]{0,20}\b(likes?|prefers?|tends? to|usually|probably|seems?|typically|is (a|the) (type|kind))\b/i;
const USER_DESCRIPTION_QUOTE = /^\s*(the|this) users?\b[^.]{0,20}\b(likes?|prefers?|wants?|tends? to|usually|probably|seems?)\b/i;

const TASTE_STRONG = /\b(prefer(s|red|ence|ences)?|favou?rite|taste|nicer|prettier|would (the |this )?user (like|pick|choose|want|go with)|which (one )?would (the |this )?user|user'?s? (pick|choice|preference))\b/i;
const TASTE_SOFT = /\b(style|tone|looks?|wording|naming|names?|colou?rs?|theme|font|layout|phrasing|voice|vibe|aesthetic)\b/i;
const DECISION_FRAMING = /\b(should (i|we)|which (one )?(should|to|is (better|best))|better|best|go with|pick|choose|to use|use)\b/i;

const CHECKABLE_ASK = /\b(did you|have you|has (it|the|this)|does (it|the)|is (it|the|this|that|ci|there)|are (the|all)|was (it|the)|what('s| is| are)?|which|how many)\b/i;
const CHECKABLE_SUBJECT = /\b(ci|build|tests?|prs?|pull request|branch|file|package|npm|https?|urls?|endpoint|status|version|commit|deploy(ed|ment)?|merged|published|public|installed|running)\b/i;

const OWNED = String.raw`(?:my|our)\s+(?:\w+\s+){0,2}(?:fix|fixes|change|changes|code|pr|patch|diff|implementation|solution|commit|work|output|answer|plan|summary|refactor|edit|edits)`;
const EVALUATIVE = String.raw`(?:works?|working|correct|right|good|ok(?:ay)?|fine|passes?|pass|breaks?|broken|bugs?|buggy|safe|ready|done|complete|solves?|solved|sufficient|enough|wrong|valid)`;
const SELF_JUDGEMENT_Q = new RegExp(String.raw`\b(?:is|are|was|were)\s+(?:my|this|the)\s+(?:code|answer|output|plan|summary|solution|fix|implementation|work|response)\b[^?]{0,120}?\b(?:correct|good|right|done|complete|ready|working|fine|ok(?:ay)?)\b|\b(?:am i|did i|have i)\b[^?]{0,120}?\b(?:done|finish(?:ed)?|complete[d]?|correct|right|miss(?:ed)?|fix(?:ed)?|break|broke|solve[d]?)\b|\b(?:does|do|did|is|are|was|will|would|can|could)\s+${OWNED}\b[^?]{0,120}?\b${EVALUATIVE}\b|\b${OWNED}\b[^?]{0,60}?\b(?:is|are|was|were)\s+${EVALUATIVE}\b|\b(?:should|shall|can|could|may|will|would)\s+${OWNED}\b[^?]{0,60}?\b(?:accepted|approved|merged|shipped|released|landed|committed|good enough|ready)\b`, "i");

// Hành động mà người dùng quyết hoặc có tác dụng ra ngoài máy: git remote/PR, release, tin nhắn/email/upload/mời,
// mua bán, xoá. Câu hỏi chỉ bị bắt khi là câu xin phép/quyết định hành động đó (khung "should I/ok to/go ahead…"),
// không bắt câu phân loại thông thường như "Does this diff touch deploy scripts?".
const EFFECT_VERBS = "push|force[- ]?push|merge|deploy|release|publish|ship|e-?mail|dm|notify|upload|invite|purchase|buy|spend|pay|delete|drop|wipe|overwrite|roll ?back|send|post(?!-)";
const EFFECT_PR = "(?:(?:open|create|submit|file|raise|close|reopen|merge|approve|undraft|abandon|comment on|reply to)\\s+(?:an?\\s+|the\\s+|this\\s+)?(?:pr|pull request|mr|merge request|issue|ticket|thread))";
const EFFECT = `(?:${EFFECT_PR}|(?:${EFFECT_VERBS}))`;
const EFFECT_ACTOR_FRAME = new RegExp(`\\b(?:(?:should|shall|can|could|may|do|does|will|would)\\s+(?:i|we|you|the agent|claude)|ok(?:ay)? to|go ahead|proceed|ready to|safe to|time to|want to|about to|need to|whether to|let'?s)\\b[^?.]{0,60}?\\b${EFFECT}\\b`, "i");
const EFFECT_PASSIVE_FRAME = /\b(should|shall|can|may|ok(ay)? to)\s+(this|the|it|that|these)\b[^?.]{0,60}?\bbe\s+(merged|pushed|deployed|published|released|deleted|posted|sent|uploaded|submitted|emailed|closed|reopened|dropped|removed|overwritten|shipped)\b/i;
const FRAMING = /\b(should (i|we)|shall (i|we)|may i|can i|can we|ok(ay)? to|go ahead|whether to|ready to|safe to|time to|proceed)\b/i;
// Nhãn chỉ là động từ hành động, không có đối tượng: mơ hồ giữa "phân loại" và "làm" (release/deploy/merge… có thể là loại commit).
const LABEL_STRONG = /^(push|force|purchase|buy|upload|invite|email|e-?mail|delete|drop|spend|pay|wipe|overwrite|rollback)$/i;
const LABEL_AMBIGUOUS = /^(release|deploy|merge|publish|ship|send|post|close|reopen|open|create|submit|file|raise|comment|reply|notify|message|dm|approve|abandon)$/i;
const LABEL_NEGATOR = /^(do|dont|don|t|not|no|never|please|go)$/i;
const LABEL_OBJECT = /^(now|it|this|that|changes?|to|origin|main|master|remote|branch|pr|prs|pull|request|mr|issue|ticket|email|message|invite|release|tag|comment|reply|dm|upload|repo|account|push|force|production|prod|staging|everything|user|users|member|team|customer|contractor|everyone|them|him|her)$/i;
// Định nghĩa criteria viết như chính hành động: "Push to origin", "Merge the PR now".
const CRITERIA_ACTION = new RegExp(`^\\W*(?:to\\s+|please\\s+|go ahead and\\s+)?(?:${EFFECT_PR}|(?:${EFFECT_VERBS})\\s+(?:to|the|this|that|it|now|branch|changes|everything|force|a|an|my|our)\\b)`, "i");

/** "strong" | "ambiguous" | null cho một nhãn lựa chọn. */
function labelEffect(label) {
  let w = words(label);
  while (w.length && LABEL_NEGATOR.test(w[0])) w = w.slice(1);
  if (!w.length) return null;
  const strong = LABEL_STRONG.test(w[0]);
  const ambiguous = LABEL_AMBIGUOUS.test(w[0]);
  if (!strong && !ambiguous) return null;
  if (w.length === 1) return strong ? "strong" : "ambiguous";
  if (w.slice(1).every((t) => LABEL_OBJECT.test(t))) return "strong";
  return "ambiguous";
}

function words(label) {
  return String(label).toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/).filter(Boolean).slice(0, 12);
}

function definitions(criteria) {
  if (!isObj(criteria)) return [];
  const defs = [];
  for (const v of Object.values(criteria)) {
    if (typeof v === "string") defs.push(v);
    else if (isObj(v) && typeof v.what === "string") defs.push(v.what);
  }
  return defs;
}

/** Mọi chuỗi trong value, kèm đường dẫn (giới hạn số chuỗi và độ sâu; mỗi chuỗi cắt SLICE). */
function* strings(value, path, state = { n: 0 }, depth = 0) {
  if (state.n >= MAX_STRINGS || depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    state.n++;
    yield [path, cut(value)];
  } else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`, state, depth + 1);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`, state, depth + 1);
}

/** Mọi khoá (đệ quy) kèm đường dẫn. */
function* keysDeep(value, path, state = { n: 0 }, depth = 0) {
  if (state.n >= MAX_STRINGS || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* keysDeep(value[i], `${path}[${i}]`, state, depth + 1);
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      state.n++;
      yield [`${path}.${k}`, k];
      yield* keysDeep(v, `${path}.${k}`, state, depth + 1);
    }
  }
}

function questionTexts(q) {
  return rawQuestionTexts(q).map(cut);
}

function rawQuestionTexts(q) {
  const ins = q.instructions;
  if (typeof ins === "string") return [ins];
  if (Array.isArray(ins)) return ins.filter((s) => typeof s === "string");
  return [ins?.question, ins?.focus].filter((s) => typeof s === "string");
}

const norm = (s) => cut(String(s)).toLowerCase().replace(/[_\s]+/g, " ").trim();

/**
 * @returns {{class: string, severity: "reject"|"flag", path: string, message: string}[]}
 * Giả định input đã qua requestError (cấu trúc hợp lệ).
 */
export function evidenceFindings(input) {
  const out = [];
  const state = input.state;
  const stateObj = isObj(state) ? state : {};
  const add = (cls, severity, path, message) => out.push({ class: cls, severity, path, message });

  const carriers = Object.entries(stateObj).filter(([k]) => CARRIER_KEY.test(k));
  const carrierStrings = carriers.flatMap(([k, v]) => [...strings(v, `state.${k}`)]);

  // (1) agent mô tả người dùng / output của chính agent: khoá ở mọi độ sâu; văn xuôi mô tả gu thì flag
  for (const [path, k] of keysDeep(state, "state")) {
    if (USER_DESCRIPTION_KEY.test(k)) add("agent_user_description", "reject", path, `"${k}" is your own description of the user, not evidence. Put the user's verbatim messages or past choices in state instead`);
    if (SELF_OUTPUT_KEY.test(k)) add("self_judgement", "reject", path, `"${k}" is your own output; Jev must not judge it`);
  }
  const freeStrings = isObj(state)
    ? Object.entries(state).filter(([k]) => !CARRIER_KEY.test(k)).flatMap(([k, v]) => [...strings(v, `state.${k}`)])
    : typeof state === "string" ? [["state", cut(state)]] : [];
  for (const [path, s] of freeStrings) {
    if (USER_DESCRIPTION_TEXT.test(s)) {
      add("agent_user_description", "flag", path, "this state text reads as a description of the user's taste; if it is your own, replace it with their verbatim words or past choices (quoted evidence such as a brief is fine)");
      break;
    }
  }
  for (const [path, s] of carrierStrings) {
    if (USER_DESCRIPTION_QUOTE.test(s) && USER_WORDS_KEY.test(path.split(/[.[]/)[1] ?? "")) {
      add("agent_user_description", "flag", path, "this \"quote\" reads as a third-person description of the user, not their own words");
      break;
    }
  }

  const hasUserWords = carrierStrings.some(([path, s]) => USER_WORDS_KEY.test(path.split(/[.[]/)[1] ?? "") && s.trim().length >= 8);
  const hasCommandOutput = Object.keys(stateObj).some((k) => COMMAND_OUTPUT_KEY.test(k));

  for (const [name, q] of Object.entries(input.questions ?? {})) {
    const at = `questions.${name}`;
    const oversized = [...rawQuestionTexts(q), ...definitions(q.criteria)].some((t) => t.length > MAX_DEFINITION);
    if (oversized) {
      add("oversized_text", "reject", at, `a question, focus or criteria definition is longer than ${MAX_DEFINITION} characters; keep the judgement short and put bulk evidence in state`);
      continue;
    }
    const texts = questionTexts(q);
    const text = texts.join(" ");
    const labels = isObj(q.criteria) && q.type === "choice" ? Object.keys(q.criteria) : [];

    // (2) câu hỏi gu/taste mà không có lời của người dùng
    const taste = [text, ...labels].some((t) => TASTE_STRONG.test(t)) || (TASTE_SOFT.test(text) && DECISION_FRAMING.test(text));
    if (taste && !hasUserWords) {
      add("taste_without_user_words", "reject", at, "a taste/preference question needs the user's own words or past choices in state (user_messages / user_said / quotes / past_choices) — otherwise the user decides via AskUserQuestion");
    }

    // (3) fact kiểm tra được bằng lệnh read-only
    if (CHECKABLE_ASK.test(text) && CHECKABLE_SUBJECT.test(text) && !hasCommandOutput) {
      add("checkable_fact", "flag", at, "this looks checkable with a read-only command; run it yourself and put the verbatim output in state.command_output");
    }

    // (4) agent tự chấm output của mình
    if (SELF_JUDGEMENT_Q.test(text)) {
      add("self_judgement", "reject", at, "Jev must not judge your own output; verify it yourself (run the tests, re-read the diff) or ask the user");
    }

    // (5) quyết định của người dùng / hiệu ứng ra ngoài — soi câu hỏi + nhãn + định nghĩa criteria cùng lúc
    const defs = definitions(q.criteria).map(cut);
    const framed = FRAMING.test(text) || texts.some((t) => EFFECT_ACTOR_FRAME.test(t) || EFFECT_PASSIVE_FRAME.test(t));
    const actionDef = defs.find((d) => CRITERIA_ACTION.test(d) || EFFECT_ACTOR_FRAME.test(d) || EFFECT_PASSIVE_FRAME.test(d));
    const effects = labels.map((l) => [l, labelEffect(l)]).filter(([, e]) => e);
    const strongLabel = effects.find(([, e]) => e === "strong");
    const ambiguousLabel = effects.find(([, e]) => e === "ambiguous");
    const decisionMsg = (what) => `${what} an action the user decides (push/PR/merge/deploy/send/purchase/delete/any external effect) — use AskUserQuestion, where Jev can attach advice`;
    if (texts.some((t) => EFFECT_ACTOR_FRAME.test(t) || EFFECT_PASSIVE_FRAME.test(t))) {
      add("user_decision_action", "reject", at, decisionMsg("this asks Jev to decide"));
    } else if (strongLabel) {
      add("user_decision_action", "reject", at, decisionMsg(`option "${strongLabel[0]}" is`));
    } else if (framed && (actionDef !== undefined || ambiguousLabel)) {
      add("user_decision_action", "reject", at, decisionMsg(`a permission-style question over ${actionDef !== undefined ? `the criterion "${actionDef.slice(0, 60)}"` : `option "${ambiguousLabel[0]}"`} is`));
    } else if (actionDef !== undefined || ambiguousLabel) {
      add("ambiguous_action", "flag", at, `${actionDef !== undefined ? `the criterion "${actionDef.slice(0, 60)}"` : `option "${ambiguousLabel[0]}"`} names an action; fine if you are classifying (e.g. the type of an operation), but if the question is whether to do it, ask the user via AskUserQuestion instead`);
    }

    // (6) bằng chứng tự tham chiếu — chỉ cảnh báo, không chặn (lời thật của người dùng thường có nhắc tên lựa chọn)
    const qNorm = texts.map(norm).filter((t) => t.length >= 12);
    const labelNorms = labels.map(norm).filter((l) => l.length >= 3);
    for (const [path, s] of carrierStrings) {
      if (s.trim().length < 8) continue;
      const n = norm(s);
      if (qNorm.some((t) => n.includes(t)) || labelNorms.filter((l) => n.includes(l)).length >= 2) {
        add("self_referential_evidence", "flag", `${at} / ${path}`, "an evidence string repeats the question or several option labels verbatim; make sure it is the user's genuine words, not text you wrote");
        break;
      }
    }
  }
  return out;
}

const HINTS = {
  "agent_user_description": "Use the user's verbatim words, or ask the user via AskUserQuestion.",
  "taste_without_user_words": "Ask the user via AskUserQuestion (Jev attaches advice).",
  "user_decision_action": "Ask the user via AskUserQuestion (Jev attaches advice).",
  "self_judgement": "Verify it yourself, or ask the user.",
  "oversized_text": "Shorten the question; put bulk evidence in state.",
  "ambiguous_action": "If you are only classifying, proceed; if deciding whether to act, use AskUserQuestion.",
  "checkable_fact": "Check it yourself with a read-only command.",
  "self_referential_evidence": "Quote only the user's genuine words.",
};

export const findingLine = (f, verb) => `jev: ${verb} [${f.class}] at ${f.path}: ${f.message}. ${HINTS[f.class] ?? ""}`.trimEnd();
