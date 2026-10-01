/**
 * Kiểm bằng chứng cho CLI `bin/jev.mjs` (ngoài kiểm cấu trúc của requestError): CLI chỉ dành cho phán đoán
 * nội bộ của agent. Toàn bộ là regex xác định, không gọi model — có false positive nên các lớp heuristic
 * yếu chỉ "flag". Reject không có đường hạ cấp: agent tự đặt env được thì luật vô nghĩa — nếu bị reject nhầm
 * thì agent tự chọn thủ công. Câu hỏi/nhãn lựa chọn là thứ bị quét để tìm hành động/gu; text bằng chứng trong state
 * (brief, report, diff) không bị quét ở lớp nào, trừ khoá mô tả người dùng và "trích dẫn" mang giọng mô tả trong khoá lời người dùng.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Khoá state chứa bằng chứng theo cấu trúc (lời người dùng, output lệnh, file) — không phải mô tả của agent.
const CARRIER_KEY = /^(user_messages|user_said|messages|quotes|past_choices|transcript|verbatim|output|stdout|stderr|command_output|files|diff)$/i;
const USER_WORDS_KEY = /^(user_messages|user_said|quotes|past_choices|messages)$/i;
const COMMAND_OUTPUT_KEY = /^(command_output|stdout|stderr|output)$/i;
const USER_DESCRIPTION_KEY = /^(user_?(profile|style|taste|prefs?|preferences?|persona|likes?|wants?|description)|about_?user|persona)$/i;
const SELF_OUTPUT_KEY = /^(my|agent|assistant|own)_?(output|answer|code|summary|work|solution)/i;

const USER_DESCRIPTION_QUOTE = /^\s*(the|this) users?\b[^.]{0,20}\b(likes?|prefers?|wants?|tends? to|usually|probably|seems?)\b/i;

const TASTE_STRONG = /\b(prefer(s|red|ence|ences)?|favou?rite|taste|nicer|prettier|would (the |this )?user (like|pick|choose|want|go with)|which (one )?would (the |this )?user|user'?s? (pick|choice|preference))\b/i;
const TASTE_SOFT = /\b(style|tone|looks?|wording|naming|names?|colou?rs?|theme|font|layout|phrasing|voice|vibe|aesthetic)\b/i;
const DECISION_FRAMING = /\b(should (i|we)|which (one )?(should|to|is (better|best))|better|best|go with|pick|choose|to use|use)\b/i;

const CHECKABLE_ASK = /\b(did you|have you|has (it|the|this)|does (it|the)|is (it|the|this|that|ci|there)|are (the|all)|was (it|the))\b/i;
const CHECKABLE_SUBJECT = /\b(ci|build|tests?|prs?|pull request|branch|file|package|npm|https?|urls?|endpoint|status|version|commit|deploy(ed|ment)?|merged|published|public|installed|running)\b/i;

const SELF_JUDGEMENT_Q = /\b(is|are|was|were)\s+(my|this|the)\s+(code|answer|output|plan|summary|solution|fix|implementation|work|response)\b[^?]*\b(correct|good|right|done|complete|ready|working|fine|ok(ay)?)\b|\b(am i|did i|have i)\b[^?]*\b(done|finish(ed)?|complete[d]?|correct|right|miss(ed)?)\b/i;

// Hành động mà người dùng quyết hoặc có tác dụng ra ngoài máy: git remote/PR, release, tin nhắn/email/upload/mời,
// mua bán, xoá. Câu hỏi chỉ bị bắt khi là câu xin phép/quyết định hành động đó (khung "should I/ok to/go ahead…"),
// không bắt câu phân loại thông thường như "Does this diff touch deploy scripts?".
const EFFECT_VERBS = "push|force[- ]?push|merge|deploy|release|publish|ship|e-?mail|dm|notify|upload|invite|purchase|buy|spend|pay|delete|drop|wipe|overwrite|roll ?back|send|post(?!-)";
const EFFECT_PR = "(?:(?:open|create|submit|file|raise|close|reopen|merge|approve|undraft|abandon|comment on|reply to)\\s+(?:an?\\s+|the\\s+|this\\s+)?(?:pr|pull request|mr|merge request|issue|ticket|thread))";
const EFFECT = `(?:${EFFECT_PR}|(?:${EFFECT_VERBS}))`;
const EFFECT_ACTOR_FRAME = new RegExp(`\\b(?:(?:should|shall|can|could|may|do|does|will|would)\\s+(?:i|we|you|the agent|claude)|ok(?:ay)? to|go ahead|proceed|ready to|safe to|time to|want to|about to|need to|whether to|let'?s)\\b[^?.]{0,60}?\\b${EFFECT}\\b`, "i");
const EFFECT_PASSIVE_FRAME = /\b(should|shall|can|may|ok(ay)? to)\s+(this|the|it|that|these)\b[^?.]{0,60}?\bbe\s+(merged|pushed|deployed|published|released|deleted|posted|sent|uploaded|submitted|emailed|closed|reopened|dropped|removed|overwritten|shipped)\b/i;
const EFFECT_OPTION_ANY = /^(push|merge|deploy|publish|purchase|buy|upload|invite|email|e-?mail|delete|drop|spend|pay|wipe|overwrite|rollback|ship|force|forcepush)$/i;
const EFFECT_OPTION_FIRST = /^(send|post|release|close|reopen|submit|open|create|file|raise|comment|reply|notify|message|dm|approve|abandon|remove|tag|order)$/i;
const EFFECT_OPTION_OBJECT = /^(pr|prs|pull|request|mr|issue|ticket|email|message|invite|release|tag|branch|comment|reply|dm|upload|repo|account)$/i;

function words(label) {
  return String(label).toLowerCase().replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^a-z0-9]+/).filter(Boolean);
}

function optionIsEffect(label) {
  const w = words(label);
  if (!w.length) return false;
  if (w.some((t) => EFFECT_OPTION_ANY.test(t))) return true;
  return EFFECT_OPTION_FIRST.test(w[0]) && (w.length === 1 || w.slice(1).some((t) => EFFECT_OPTION_OBJECT.test(t) || /^(now|it|this|changes?)$/.test(t)));
}

/** Mọi chuỗi trong value, kèm đường dẫn. */
function* strings(value, path) {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
}

function questionTexts(q) {
  const ins = q.instructions;
  if (typeof ins === "string") return [ins];
  if (Array.isArray(ins)) return ins.filter((s) => typeof s === "string");
  return [ins?.question, ins?.focus].filter((s) => typeof s === "string");
}

const norm = (s) => String(s).toLowerCase().replace(/[_\s]+/g, " ").trim();

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

  // (1) agent mô tả người dùng
  for (const k of Object.keys(stateObj)) {
    if (USER_DESCRIPTION_KEY.test(k)) add("agent_user_description", "reject", `state.${k}`, `"${k}" is your own description of the user, not evidence. Put the user's verbatim messages or past choices in state instead`);
    if (SELF_OUTPUT_KEY.test(k)) add("self_judgement", "reject", `state.${k}`, `"${k}" is your own output; Jev must not judge it`);
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

    // (5) quyết định của người dùng / hiệu ứng ra ngoài
    const optionHit = labels.find(optionIsEffect);
    if (EFFECT_ACTOR_FRAME.test(text) || EFFECT_PASSIVE_FRAME.test(text) || optionHit !== undefined) {
      add("user_decision_action", "reject", at, `${optionHit !== undefined ? `option "${optionHit}" is` : "this is"} an action the user decides (push/PR/merge/deploy/send/purchase/delete/any external effect) — use AskUserQuestion, where Jev can attach advice`);
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
  "checkable_fact": "Check it yourself with a read-only command.",
  "self_referential_evidence": "Quote only the user's genuine words.",
};

export const findingLine = (f, verb) => `jev: ${verb} [${f.class}] at ${f.path}: ${f.message}. ${HINTS[f.class] ?? ""}`.trimEnd();
