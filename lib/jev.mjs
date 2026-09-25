import { readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./env.mjs";

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

// Cache ở module scope — logEvent là hot path, không shell out git mỗi dòng log.
let repoUrl;
let repoUrlCached = false;
function getRepoUrl() {
  if (!repoUrlCached) {
    repoUrlCached = true;
    try {
      repoUrl = execSync("git config --get remote.origin.url", { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
        .replace(/(^[a-z]+:\/\/)[^/@]+@/i, "$1") || undefined; // bỏ user[:token]@ nếu có, để lộ token là rò rỉ bảo mật
    } catch {
      repoUrl = undefined; // không phải git repo, không có remote, v.v.
    }
  }
  return repoUrl;
}

// PASEO_AGENT_ID: duy nhất theo từng agent instance (khác AI_AGENT — chỉ mô tả loại agent,
// giống nhau cho mọi phiên; xem quyết định của Jev khi chọn field này).
const agentId = process.env.PASEO_AGENT_ID || undefined;

/** Một dòng JSON mỗi sự kiện. Không bao giờ throw — logging không được phép làm hỏng caller. */
export function logEvent(event) {
  if (env("LOG") === "0") return;
  try {
    const repo = getRepoUrl();
    const line = {
      ts: new Date().toISOString(),
      ...(repo ? { repo } : {}),
      ...(agentId ? { agent: agentId } : {}),
      ...event,
    };
    appendFileSync(logFilePath(), JSON.stringify(line) + "\n");
  } catch {
    // đĩa đầy, thư mục không tồn tại, v.v. — bỏ qua
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
    const err = new Error(`${isVercel ? "gateway" : "typesafe"} ${res.status} ${body.slice(0, 120)}${hint}`);
    err.status = res.status;
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
export async function askJev(key, state, questions, source = "cli", budgetMs = TIMEOUT_MS, stateSizes) {
  const start = Date.now();
  const deadline = start + budgetMs;
  let status = "ok";
  let error;
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
    error = err.message;
    throw err;
  } finally {
    logEvent({
      kind: "call", source, status, error, retried: attempts > 1, attempts, latency_ms: Date.now() - start, provider: name, model: info.model, ...(info.apiModel ? { api_model: info.apiModel } : {}),
      n_questions: Object.keys(sent).length, ...(stateSizes ? { state_sizes: stateSizes } : {}), // đôi lên với câu boolean — có chủ đích
    });
  }
}
