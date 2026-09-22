import { readFileSync, appendFileSync } from "node:fs";
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

export function logFilePath() {
  return env("LOG_FILE", join(homedir(), ".claude", "ask-jev.log"));
}

/** Một dòng JSON mỗi sự kiện. Không bao giờ throw — logging không được phép làm hỏng caller. */
export function logEvent(event) {
  if (env("LOG") === "0") return;
  try {
    appendFileSync(logFilePath(), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
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
  try {
    try {
      return await attempt(key, state, questions, perAttempt);
    } catch (err) {
      if (!(err.status >= 500 && err.status < 600)) throw err;
      retried = true;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
      return await attempt(key, state, questions, perAttempt);
    }
  } catch (err) {
    status = "error";
    error = err.message;
    throw err;
  } finally {
    logEvent({
      kind: "call", source, status, error, retried, latency_ms: Date.now() - start, model: MODEL,
      n_questions: Object.keys(questions).length, ...(stateSizes ? { state_sizes: stateSizes } : {}),
    });
  }
}
