import { readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "./env.mjs";

const GATEWAY = env("GATEWAY_URL", "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
const MODEL = env("MODEL", "typesafe-ai/jev");
const BACKOFF_MS = 300;
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
    if (!isObj(q.criteria)) return `${at}.criteria is required — ${CRITERIA_SHAPE}`;
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

/**
 * Khoá: biến môi trường trước, rồi tới file — để không phải nhét secret vào settings.json.
 * `ASK_JEV_API_KEY` được ưu tiên hơn `AI_GATEWAY_API_KEY` (tên gốc của Vercel, vẫn giữ
 * nguyên vì đó là tên gateway, không phải tên riêng của plugin).
 */
export function apiKey() {
  const key = process.env.ASK_JEV_API_KEY || process.env.AI_GATEWAY_API_KEY;
  if (key) return key.trim();
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

async function attempt(key, state, questions, timeoutMs) {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": MODEL,
    },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`gateway ${res.status} ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).answers;
}

const MIRROR = "__mirror";

// KIỂM ĐỊNH GIẢ THUYẾT KHÔNG (null hypothesis): mỗi câu boolean được hỏi thêm ở KHUNG NGƯỢC.
// Câu xuôi = H1 ("hành động"); twin = H0 = mặc định an toàn. twin.criteria.true = câu gốc.false,
// nên twin.P(true) = P(H0 giữ) và b = 1 - twin.P(true) là ước lượng độc lập THỨ HAI cho
// P(gốc.true), nhìn từ phía đối lập. Câu choice để nguyên — không mirror.
// `q.safe` là marker NỘI BỘ (phía an toàn), phải tước trước khi gửi API — gateway chỉ nhận
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

// Reproduced live: the identical payload 503'd ("Service temporarily unavailable") on one
// attempt and 200'd on the next, independent of payload size/shape — the typesafe-ai
// provider itself is flaky, with no gateway-side fallback. One quick retry on 5xx only
// (never on our own timeout, which already ate the budget) covers this in practice.
//
// Mỗi attempt được cấp (budgetMs - BACKOFF_MS) / 2, dù retry có xảy ra hay không — vì
// không biết trước lúc gọi attempt đầu liệu có cần retry, phải giả định CÓ. Nhờ vậy tổng
// thời gian tệ nhất (attempt1 + backoff + attempt2) không bao giờ vượt budgetMs. Caller
// (mỗi gate) truyền budgetMs = ngân sách nó muốn cho CẢ lệnh gọi này; hooks.json phải đặt
// timeout >= budgetMs/1000 + 1s margin cho MỖI lệnh gọi askJev tuần tự mà gate đó có thể làm
// (vd stop.mjs gọi tối đa 3 lần tuần tự → timeout >= 3 × (budgetMs/1000 + 1)).
export async function askJev(key, state, questions, source = "cli", budgetMs = TIMEOUT_MS, stateSizes) {
  const start = Date.now();
  let status = "ok";
  let error;
  let retried = false;
  const perAttempt = Math.max(1000, Math.floor((budgetMs - BACKOFF_MS) / 2));
  const sent = withMirrors(questions); // twin H0 cho mọi câu boolean, gửi chung một call
  try {
    let raw;
    try {
      raw = await attempt(key, state, sent, perAttempt);
    } catch (err) {
      if (!(err.status >= 500 && err.status < 600)) throw err;
      retried = true;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
      raw = await attempt(key, state, sent, perAttempt);
    }
    return reconcile(questions, raw);
  } catch (err) {
    status = "error";
    error = err.message;
    throw err;
  } finally {
    logEvent({
      kind: "call", source, status, error, retried, latency_ms: Date.now() - start, model: MODEL,
      n_questions: Object.keys(sent).length, ...(stateSizes ? { state_sizes: stateSizes } : {}), // đôi lên với câu boolean — có chủ đích
    });
  }
}
