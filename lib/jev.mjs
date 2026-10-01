import { readFileSync, appendFileSync, statSync, chmodSync, openSync, closeSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { env } from "./env.mjs";
import { autonomy } from "./gate.mjs";
import { VERSION } from "./version.mjs";

// Hai provider: `typesafe` (mặc định, gọi thẳng api.typesafe.ai) và `vercel` (legacy, qua Vercel AI Gateway).
const PROVIDERS = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyEnv: "TYPESAFE_API_KEY" },
  vercel: { url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", model: "typesafe-ai/jev", keyEnv: "AI_GATEWAY_API_KEY" },
};
const BACKOFF_MS = 300;
const MIN_ATTEMPT_MS = 1500; // p90 latency của call thành công ngay lần đầu (log 2026-09-20→23)
// budgetMs (5º tham số askJev) là ngân sách TỔNG cho cả lượt thử lại, không phải mỗi
// attempt — bug cũ: 2 attempt full-timeout cộng backoff (4000+300+4000=8300ms) có thể vượt
// timeout của hooks.json (8000ms), hook bị Claude Code kill giữa chừng = fail-open câm lặng.
const TIMEOUT_MS = 8_000;
// Khoảng đệm tối thiểu giữa deadline nội bộ của askJev và timeout của hook (hooks.json) — nếu host kill
// hook trước deadline thì không dòng log nào được ghi (rủi ro còn lại, không xử lý được trong process).
export const DEFAULT_BUDGET_MS = TIMEOUT_MS;
export const HOOK_MARGIN_MS = 1_000;
export const LOG_SCHEMA = 2;

// Định dạng request dùng chung cho SessionStart, lời nhắc mỗi lượt và lỗi CLI — một nguồn duy nhất.
// Lời nhắc có sẵn lệnh chạy nên agent hay bỏ qua skill; thiếu shape ở đây thì nó tự chế
// (regression thật: Sonnet 5 gửi {task, context, question} như hỏi một LLM chat).
export const NOT_CHAT = "Jev is a classifier, not a chat model: it only scores the answers you define in criteria — no free-text questions.";
export const REQUEST_SHAPE = `{"state": {...evidence verbatim}, "questions": {"<name>": {"type": "boolean"|"choice", "instructions": {"question": "..."}, "criteria": {...}}}}`;
export const CRITERIA_SHAPE = `boolean criteria = {"true": "<definition>", "false": "<definition>"}; choice criteria = {"<option>": {"what": "...", "not_for": "<other options>", "examples": [...]}, ...} (2+ options)`;

const TYPES = new Set(["boolean", "noul", "choice", "score"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Chỉ kiểm cấu trúc JSON do agent tự viết (ranh giới tin cậy của CLI). Nội dung
// instructions/criteria gateway nhận linh hoạt (string/object/array) nên không siết thêm.
export function requestError(input) {
  if (!isObj(input) || input.state == null || !isObj(input.questions) || !Object.keys(input.questions).length) {
    return `input must be ${REQUEST_SHAPE}; got ${isObj(input) ? `keys: ${Object.keys(input).join(", ") || "none"}` : JSON.stringify(input)}`;
  }
  for (const [name, q] of Object.entries(input.questions)) {
    const at = `questions.${name}`;
    if (!isObj(q)) return `${at} must be an object`;
    if (!TYPES.has(q.type)) return `${at}.type must be one of ${[...TYPES].join(", ")}; got ${JSON.stringify(q.type)}`;
    if (q.instructions == null) return `${at}.instructions is required, e.g. {"question": "..."}`;
    if (q.type === "score" ? !q.criteria || typeof q.criteria !== "object" : !isObj(q.criteria)) return `${at}.criteria is required — ${CRITERIA_SHAPE}`;
    if ((q.type === "boolean" || q.type === "noul") && (q.criteria.true == null || q.criteria.false == null)) {
      return `${at}.criteria needs both "true" and "false" definitions`;
    }
    if (q.type === "choice" && Object.keys(q.criteria).length < 2) return `${at}.criteria needs 2+ options — ${CRITERIA_SHAPE}`;
  }
  return null;
}

export function logFilePath() {
  return env("LOG_FILE", join(homedir(), ".claude", "ask-jev.log"));
}

/** Bỏ userinfo, query và fragment khỏi mọi URL trong chuỗi — để lộ token là rò rỉ bảo mật. */
export function stripUrlSecrets(text) {
  return String(text ?? "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*@)?([^\s?#]*)(?:[?#]\S*)?/gi, "$1$3");
}

// Cache ở module scope — logEvent là hot path, không shell out git mỗi dòng log.
let repoUrl;
let repoUrlCached = false;
function getRepoUrl() {
  if (!repoUrlCached) {
    repoUrlCached = true;
    try {
      repoUrl = stripUrlSecrets(
        execSync("git config --get remote.origin.url", { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(),
      ).replace(/[?#].*$/, "") || undefined; // dạng scp (git@host:o/r) không có "://" nên chỉ cần bỏ query/fragment
    } catch {
      repoUrl = undefined; // không phải git repo, không có remote, v.v.
    }
  }
  return repoUrl;
}

// PASEO_AGENT_ID: duy nhất theo từng agent instance (khác AI_AGENT — chỉ mô tả loại agent,
// giống nhau cho mọi phiên; xem quyết định của Jev khi chọn field này).
const agentId = process.env.PASEO_AGENT_ID || undefined;

// Metadata của một lệnh gọi logic (invocation_id, session_id, source, threshold) đi theo AsyncLocalStorage:
// hai request Paseo chạy xen kẽ trong cùng process không được lẫn trường dấu của nhau.
const invocationStore = new AsyncLocalStorage();
let processInvocationId;

export function runInvocation(ctx, fn) {
  return invocationStore.run({ ...(ctx ?? {}) }, fn);
}

export function currentInvocation() {
  return invocationStore.getStore();
}

function defaultThreshold() {
  const t = Number(env("ASK_THRESHOLD", 0.8));
  return Number.isFinite(t) ? t : 0.8;
}

const tightened = new Set();
// File log tạo mới với 0600 (mode chỉ có tác dụng lúc tạo); log cũ 0644 được siết một lần mỗi process.
function tightenLog(path) {
  if (tightened.has(path)) return;
  tightened.add(path);
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  } catch {
    // chưa tồn tại (sẽ tạo 0600) hoặc không chmod được — best effort
  }
}

// C0 (trừ \n, \t), DEL, C1, zero-width, bidi override/isolate, U+2028/9: chuỗi lấy từ log mà in thẳng ra terminal có thể
// chứa escape (ESC]0;… / ESC[2J) — ghi vào log đã bỏ, và nơi in log (jev stats) bỏ thêm lần nữa cho dòng cũ.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const PRINT_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

/** Chuỗi an toàn để in ra terminal: mọi ký tự điều khiển/ẩn (kể cả xuống dòng) thành một khoảng trắng. */
export function printable(value) {
  return String(value ?? "").replace(PRINT_CONTROL_CHARS, " ");
}

function scrub(v) {
  if (typeof v === "string") return v.replace(CONTROL_CHARS, "");
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

const FIELD_CAP = 300;
const REASON_CAP = 160;
const MAX_LIST = 50;
const capText = (v, n) => (typeof v === "string" && v.length > n ? `${v.slice(0, n - 1)}…` : v);
const NAME_CAP = 120;
const MAX_WARNINGS = 20;
const asCapped = (x) => (typeof x === "string" ? capText(x, FIELD_CAP) : x !== null && typeof x === "object" ? capText(JSON.stringify(x), FIELD_CAP) : x);
// Mảng → cắt từng phần tử (≤50); giá trị đơn (chuỗi/object) cũng bị cắt thay vì lọt qua.
const capList = (v) => (Array.isArray(v) ? v.slice(0, MAX_LIST).map(asCapped) : asCapped(v));
const capWarnings = (v) =>
  Array.isArray(v)
    ? v.slice(0, MAX_WARNINGS).map((w) => (w && typeof w === "object"
      ? { class: capText(String(w.class ?? ""), 40), path: capText(String(w.path ?? ""), FIELD_CAP), message: capText(String(w.message ?? ""), FIELD_CAP) }
      : capText(String(w), FIELD_CAP)))
    : asCapped(v);

/** Giới hạn độ dài tập trung cho mọi writer (design §D.5): question/question_text/option/chosen/free-text ≤300, question_name ≤120, warnings ≤20 mục × (path, message ≤300), reason ≤160, advice_text ≤300; repo bỏ userinfo/query/fragment. */
function sanitizeRow(line) {
  for (const k of Object.keys(line)) line[k] = scrub(line[k]);
  for (const k of ["question", "question_text", "advice_text"]) line[k] = capText(line[k], FIELD_CAP);
  line.reason = capText(line.reason, REASON_CAP);
  line.question_name = capText(line.question_name, NAME_CAP);
  line.warnings = capWarnings(line.warnings);
  for (const k of ["options", "chosen", "recommended"]) line[k] = capList(line[k]);
  if (line.repo !== undefined) {
    const clean = typeof line.repo === "string" ? stripUrlSecrets(line.repo).replace(/[?#].*$/, "") : "";
    if (clean) line.repo = clean;
    else delete line.repo;
  }
  return line;
}

/**
 * Một dòng JSON mỗi sự kiện. Không bao giờ throw — logging không được phép làm hỏng caller.
 * Mọi dòng được đóng dấu schema/version/invocation_id/session_id/autonomy/threshold (lib/ doc: schema v2);
 * `event_id` luôn do đây phát ra (truy vết từng dòng); `repo`/`agent` suy từ tiến trình hiện tại
 * nhưng `event` (agent/repo/session_id/request_id do caller truyền, vd Paseo plugin ngoài git
 * repo của phiên này) ghi đè vì được spread sau cùng.
 */
export function logEvent(event) {
  if (env("LOG") === "0") return;
  try {
    const repo = getRepoUrl();
    const ctx = currentInvocation() ?? {};
    processInvocationId ??= randomUUID();
    const line = {
      ts: new Date().toISOString(),
      event_id: randomUUID(),
      schema: LOG_SCHEMA,
      version: VERSION,
      invocation_id: ctx.invocation_id ?? processInvocationId,
      session_id: ctx.session_id ?? null,
      autonomy: autonomy(),
      threshold: ctx.threshold !== undefined ? ctx.threshold : defaultThreshold(),
      ...(ctx.source && !event.source ? { source: ctx.source } : {}),
      ...(repo ? { repo } : {}),
      ...(agentId ? { agent: agentId } : {}),
      ...event,
    };
    for (const k of ["invocation_id", "session_id", "threshold"]) if (line[k] === undefined) line[k] = null;
    sanitizeRow(line);
    const path = logFilePath();
    tightenLog(path);
    appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch {
    // đĩa đầy, thư mục không tồn tại, v.v. — bỏ qua
  }
}

const SECRET_TOKEN = "[\\w.~+/=-]";
// [regex, replacement] — thứ tự quan trọng: header/ngữ cảnh trước, rồi tới token trơ.
const REDACT_PATTERNS = [
  [/\b(authorization\s*[:=]\s*)(?:basic|bearer|token)\s+\S+/gi, "$1[redacted]"],
  [/\bBearer\s+[\w.~+/=-]+/gi, "[redacted]"],
  [/\bBasic\s+(?=[A-Za-z0-9+/]*[\d=+/])[A-Za-z0-9+/]{8,}={0,2}/g, "[redacted]"],
  [/\b(api[_-]?key|token|secret|authorization|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]"],
  [new RegExp(`\\b(token|api[ _-]?key|secret|password)\\s+(?=${SECRET_TOKEN}*\\d)${SECRET_TOKEN}{8,}`, "gi"), "$1 [redacted]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|sk|vck|pk|ts|tsk|xox[abp])[-_][\w-]{6,}/gi, "[redacted]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
];
const ERROR_TEXT_CAP = 200;

/** Xoá key/token, userinfo/query/fragment của URL khỏi văn bản bất kỳ (không cắt độ dài) — dùng cho stderr của CLI. */
export function redactSecrets(text, key) {
  let out = String(text ?? "");
  if (key && key.length >= 4) out = out.split(key).join("[redacted]");
  out = stripUrlSecrets(out);
  for (const [re, to] of REDACT_PATTERNS) out = out.replace(re, to);
  return out.replace(/\s+/g, " ").trim();
}

/** Văn bản lỗi từ provider trước khi vào log: redact toàn văn rồi mới cắt ≤200. */
export function redactError(text, key) {
  const out = redactSecrets(text, key);
  return out.length > ERROR_TEXT_CAP ? `${out.slice(0, ERROR_TEXT_CAP - 1)}…` : out;
}

const BILLING_RE = /credit|billing|quota|payment/i;

/** billing|auth|rate_limit|timeout|server|network|other — billing đứng đầu: 402, hoặc body nhắc credit/billing/quota/payment. */
export function classifyError(err) {
  const status = err?.status;
  if (status === 402 || BILLING_RE.test(err?.body ?? "")) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status < 600) return "server";
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || /timed? ?out/i.test(err?.message ?? "")) return "timeout";
  if (err instanceof TypeError || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(`${err?.message} ${err?.cause?.code ?? ""}`)) return "network";
  return "other";
}

const billingMarkerPath = (sessionId) =>
  join(env("STATE_DIR") || dirname(logFilePath()), `.ask-jev-billing-${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}`);

function billingMarkerExists(sessionId) {
  try {
    statSync(billingMarkerPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Thông báo billing đã hiện cho session_id này chưa? Marker (atomic) hoặc dòng provider_error trong log — hai process hook cùng phiên thấy nhau. */
export function billingNoteShown(sessionId) {
  if (!sessionId) return false;
  if (billingMarkerExists(sessionId)) return true;
  try {
    for (const line of readFileSync(logFilePath(), "utf8").split("\n")) {
      if (!line.includes(sessionId)) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === "provider_error" && e.billing === true && e.notified_user === true && e.session_id === sessionId) return true;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Giành quyền hiện thông báo billing: tạo marker O_EXCL (0600) — đúng một process thắng. Không tạo được marker (lỗi ngoài EEXIST) → quay về đọc log. */
export function claimBillingNote(sessionId) {
  if (!sessionId) return true;
  try {
    closeSync(openSync(billingMarkerPath(sessionId), "wx", 0o600));
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    return !billingNoteShown(sessionId);
  }
}

// ASK_JEV_PROVIDER không phân biệt hoa thường; giá trị lạ thì lỗi rõ ràng thay vì đoán.
function explicitProvider() {
  const p = env("PROVIDER")?.trim().toLowerCase();
  if (!p) return undefined;
  if (!Object.hasOwn(PROVIDERS, p)) throw new Error(`ASK_JEV_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}; got ${JSON.stringify(env("PROVIDER"))}`);
  return p;
}

// Provider: ASK_JEV_PROVIDER nếu đặt; không thì suy từ key — `vck_` hoặc key lấy từ AI_GATEWAY_API_KEY
// (kể cả OIDC token không có tiền tố) là Vercel, còn lại là typesafe.
export function provider(key) {
  const p = explicitProvider();
  if (p) return p;
  const trim = (v) => v?.trim();
  const fromLegacyVar = key && key === trim(process.env.AI_GATEWAY_API_KEY) && key !== trim(process.env.ASK_JEV_API_KEY) && key !== trim(process.env.TYPESAFE_API_KEY);
  return key?.startsWith("vck_") || fromLegacyVar ? "vercel" : "typesafe";
}

export function endpoint(name) {
  return { url: env("API_URL", env("GATEWAY_URL", PROVIDERS[name].url)), model: env("MODEL", PROVIDERS[name].model) };
}

/**
 * Khoá: biến môi trường trước, rồi tới file — để không phải nhét secret vào settings.json.
 * `ASK_JEV_API_KEY` luôn đứng đầu; nếu ASK_JEV_PROVIDER được đặt thì biến gốc của provider đó
 * đứng kế tiếp. `AI_GATEWAY_API_KEY` (Vercel) chỉ còn là fallback cũ, deprecated.
 */
export function apiKey() {
  const names = ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"];
  const p = env("PROVIDER")?.trim().toLowerCase();
  const chosen = Object.hasOwn(PROVIDERS, p ?? "") ? PROVIDERS[p].keyEnv : undefined;
  if (chosen) names.unshift(chosen);
  for (const name of ["ASK_JEV_API_KEY", ...names]) {
    const key = process.env[name]?.trim();
    if (key) return key;
  }
  for (const name of ["ask-jev.key", "jev-ask.key"]) {
    try {
      const key = readFileSync(join(homedir(), ".claude", name), "utf8").trim();
      if (key) return key;
    } catch {
      // thử tên kế tiếp
    }
  }
  return null;
}

const wireQuestions = (questions) =>
  Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, q?.type === "boolean" ? { ...q, type: "noul" } : q]));

// typesafe trả noul: p; phần còn lại của plugin đọc .probability.
const noulToProbability = (answers) => {
  for (const [k, a] of Object.entries(answers ?? {})) {
    if (typeof a?.noul !== "number") continue;
    const { type, noul, ...rest } = a;
    answers[k] = { ...rest, probability: noul };
  }
  return answers;
};

// confidence của câu boolean = xác suất của phía thắng, max(p, 1-p), tính từ p CUỐI (sau reconcile) —
// cùng quy ước với choice (probabilities[choice]) và với các gate; confidence thô của provider
// mô tả p trước khi trộn twin nên sẽ lệch.
const withConfidence = (questions, answers) => {
  for (const [name, q] of Object.entries(questions)) {
    const p = answers?.[name]?.probability;
    if ((q?.type === "boolean" || q?.type === "noul") && typeof p === "number") answers[name] = { ...answers[name], confidence: Math.max(p, 1 - p) };
  }
  return answers;
};

async function attempt(key, state, questions, timeoutMs, info) {
  const isVercel = info.provider === "vercel";
  const res = await fetch(info.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(isVercel && {
        "ai-gateway-protocol-version": "0.0.1",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": info.model,
      }),
    },
    body: JSON.stringify(isVercel ? { state, questions } : { state, model: info.model, questions: wireQuestions(questions) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let hint = "";
    if (res.status === 401) {
      if (!isVercel) {
        hint = key.startsWith("vck_")
          ? " — a vck_ key is a Vercel key: set ASK_JEV_PROVIDER=vercel, or get a typesafe key at https://console.typesafe.ai/keys"
          : " — the key must come from https://console.typesafe.ai/keys";
      } else if (!key.startsWith("vck_")) {
        hint = " — this does not look like a Vercel key (vck_...): if it is a typesafe key, set ASK_JEV_PROVIDER=typesafe";
      }
    }
    const err = new Error(`${isVercel ? "gateway" : "typesafe"} ${res.status} ${redactSecrets(body, key).slice(0, 120)}${hint}`);
    err.status = res.status;
    err.body = body.slice(0, 2_000);
    err.retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 0;
    throw err;
  }
  const json = await res.json();
  info.apiModel = json.model;
  return isVercel ? json.answers : noulToProbability(json.answers);
}

const MIRROR = "__mirror";

// KIỂM ĐỊNH GIẢ THUYẾT KHÔNG (null hypothesis): mỗi câu boolean được hỏi thêm ở KHUNG NGƯỢC.
// Câu xuôi = H1 ("hành động"); twin = H0 = mặc định an toàn. twin.criteria.true = câu gốc.false,
// nên twin.P(true) = P(H0 giữ) và b = 1 - twin.P(true) là ước lượng độc lập THỨ HAI cho
// P(gốc.true), nhìn từ phía đối lập. Câu choice để nguyên — không mirror.
// `q.safe` là marker NỘI BỘ (phía an toàn), phải tước trước khi gửi API — API chỉ nhận
// {type, instructions, criteria}.
export function withMirrors(questions) {
  const out = {};
  for (const [name, q] of Object.entries(questions)) {
    const { safe, ...clean } = q ?? {};
    out[name] = clean;
    if (q?.type !== "boolean" || !q.criteria) continue;
    out[`${name}${MIRROR}`] = {
      type: "boolean",
      instructions: {
        ...q.instructions,
        // ponytail: chỉ đảo criteria + thêm ghi chú khung-null; KHÔNG tự viết lại free-text
        // (đảo câu chữ tự động không đáng tin) — trần: cần đảo đúng câu thì phải nhờ model.
        question: `Null hypothesis — opposite framing of the SAME facts: does the safe default hold (no action / no change warranted)? ${q.instructions?.question ?? ""}`,
      },
      criteria: { true: q.criteria.false, false: q.criteria.true },
    };
  }
  return out;
}

// REJECT-THE-NULL, BẤT ĐỐI XỨNG. Với mỗi câu boolean: a = P(gốc.true) khung xuôi,
// b = 1 - twin.P(true) suy từ H0; mean = (a+b)/2; agreement = 1 - |a-b|.
//   p_eff = mean * agreement + s * (1 - agreement)
// với s = PHÍA AN TOÀN của xác suất do câu hỏi khai báo qua `q.safe`: true→1, false→0, không
// khai báo→0.5. Đồng thuận (agreement→1) ⇒ p_eff = mean (giữ nguyên quyết định). Mâu thuẫn
// (agreement→0) ⇒ p_eff → s, tức kéo THẲNG về phía an toàn của CHÍNH gate đó — không phải về 0.5.
// Các gate KHÔNG đối xứng quanh 0.5 (block cần p≥0.85, allow cần p<0.3, defer cần p>0.5...), nên
// kéo về 0.5 sẽ đẩy nửa số gate sang hành động RỦI RO. Vì p_eff đi đơn điệu từ mean tới s khi
// agreement giảm, mâu thuẫn CHỈ có thể làm gate bảo thủ hơn, không bao giờ vượt ngưỡng sang phía
// rủi ro. Câu không marker (vd o0/o1 của multiSelect) → s=0.5: mâu thuẫn kéo về giữa = vùng hỏi,
// đúng nghĩa bảo thủ cho các gate lấy 0.5 làm mốc không-chắc.
export function reconcile(questions, answers) {
  if (!answers) return answers;
  for (const [name, q] of Object.entries(questions)) {
    if (q?.type !== "boolean") continue;
    const fwd = answers[name]?.probability;
    const twin = answers[`${name}${MIRROR}`]?.probability;
    delete answers[`${name}${MIRROR}`]; // giữ nguyên shape callers mong đợi
    if (typeof fwd !== "number" || typeof twin !== "number") continue; // thiếu mirror → dùng forward như cũ
    const mean = (fwd + (1 - twin)) / 2;
    const agreement = 1 - Math.abs(fwd - (1 - twin));
    const s = q.safe === true ? 1 : q.safe === false ? 0 : 0.5;
    answers[name] = { ...answers[name], probability: mean * agreement + s * (1 - agreement) };
  }
  return answers;
}

// (Vercel path) Reproduced live: the identical payload 503'd ("Service temporarily unavailable") on one
// attempt and 200'd on the next, independent of payload size/shape — the typesafe-ai
// provider itself is flaky, with no gateway-side fallback. Log 2026-09-20→23: 1202/6500 calls
// still 503'd after ONE retry (18%; ask gate 11/41), while that retry rescued 42% — and a 503
// comes back in ~1.2s, so one retry left most of an 8s budget unused. Retry 5xx and 429 (honoring retry-after; never our own
// timeout, which already ate the budget) with doubling backoff until the budget runs out.
//
// Mỗi attempt được cấp tối đa (budgetMs - BACKOFF_MS) / 2 — để một attempt treo vẫn chừa chỗ
// cho ít nhất một retry — và không bao giờ quá phần còn lại tới deadline, nên tổng thời gian
// tệ nhất không vượt budgetMs. Chỉ bắt đầu retry khi còn >= backoff + MIN_ATTEMPT_MS (p90 của
// call thành công), không thì attempt đó gần như chắc chắn tự timeout. Budget 4s (các gate)
// vẫn ra 2 attempt như cũ; 8s (ask gate, CLI) ra ~4. Backoff gấp đôi chặn bão retry khi
// gateway fail nhanh. Caller (mỗi gate) truyền budgetMs = ngân sách nó muốn cho CẢ lệnh gọi
// này; hooks.json phải đặt timeout >= budgetMs/1000 + 1s margin cho MỖI lệnh gọi askJev tuần
// tự mà gate đó có thể làm (vd stop.mjs gọi tối đa 3 lần tuần tự → timeout >= 3 × (budgetMs/1000 + 1)).
export async function askJev(key, state, questions, source = "cli", budgetMs = TIMEOUT_MS, stateSizes, meta = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  let status = "ok";
  let failure;
  let attempts = 0;
  const perAttempt = Math.max(1000, Math.floor((budgetMs - BACKOFF_MS) / 2));
  let name = "unknown";
  let info = {};
  const sent = withMirrors(questions); // twin H0 cho mọi câu boolean, gửi chung một call
  try {
    name = provider(key);
    info = { provider: name, ...endpoint(name) };
    let raw;
    for (let backoff = BACKOFF_MS; ; backoff *= 2) {
      attempts++;
      try {
        raw = await attempt(key, state, sent, Math.min(perAttempt, deadline - Date.now()), info);
        break;
      } catch (err) {
        const wait = Math.max(backoff, err.retryAfterMs ?? 0);
        if (!((err.status >= 500 && err.status < 600) || err.status === 429) || deadline - Date.now() < wait + MIN_ATTEMPT_MS) throw err;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    return withConfidence(questions, reconcile(questions, raw));
  } catch (err) {
    status = "error";
    failure = err;
    throw err;
  } finally {
    const errorClass = failure ? classifyError(failure) : undefined;
    const message = failure ? redactError(failure.message, key) : undefined;
    const httpStatus = failure?.status;
    logEvent({
      kind: "call", source, status, ...(failure ? { error: message, error_class: errorClass, ...(httpStatus ? { http_status: httpStatus } : {}) } : {}),
      retried: attempts > 1, attempts, latency_ms: Date.now() - start, provider: name, model: info.model, ...(info.apiModel ? { api_model: info.apiModel } : {}),
      n_questions: Object.keys(sent).length, ...(stateSizes ? { state_sizes: stateSizes } : {}), // đôi lên với câu boolean — có chủ đích
      ...meta, // agent/repo/session_id/request_id tường minh (vd Paseo plugin) đè giá trị suy từ tiến trình
    });
    if (failure) {
      const billing = errorClass === "billing";
      const sid = meta.session_id ?? currentInvocation()?.session_id;
      const notifyBilling = billing && claimBillingNote(sid);
      failure.errorClass = errorClass;
      failure.notice = billing && notifyBilling ? "billing" : "generic";
      logEvent({
        kind: "provider_error", source, ...(meta.gate ? { gate: meta.gate } : {}), ...(meta.question_index !== undefined ? { question_index: meta.question_index } : {}),
        error_class: errorClass, ...(httpStatus ? { http_status: httpStatus } : {}), message, fail_open: true, billing, notified_user: notifyBilling,
        ...meta,
      });
    }
  }
}
