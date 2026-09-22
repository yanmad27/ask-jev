import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GATEWAY = process.env.JEV_GATEWAY_URL ?? "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const MODEL = process.env.JEV_MODEL ?? "typesafe-ai/jev";
const TIMEOUT_MS = 8_000;

export function logFilePath() {
  return process.env.JEV_LOG_FILE || join(homedir(), ".claude", "ask-jev.log");
}

/** Một dòng JSON mỗi sự kiện. Không bao giờ throw — logging không được phép làm hỏng caller. */
export function logEvent(event) {
  if (process.env.JEV_LOG === "0") return;
  try {
    appendFileSync(logFilePath(), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // đĩa đầy, thư mục không tồn tại, v.v. — bỏ qua
  }
}

/** Khoá: biến môi trường trước, rồi tới file — để không phải nhét secret vào settings.json. */
export function apiKey() {
  if (process.env.AI_GATEWAY_API_KEY) return process.env.AI_GATEWAY_API_KEY.trim();
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
export async function askJev(key, state, questions, source = "cli", timeoutMs = TIMEOUT_MS) {
  const start = Date.now();
  let status = "ok";
  let error;
  let retried = false;
  try {
    try {
      return await attempt(key, state, questions, timeoutMs);
    } catch (err) {
      if (!(err.status >= 500 && err.status < 600)) throw err;
      retried = true;
      await new Promise((r) => setTimeout(r, 300));
      return await attempt(key, state, questions, timeoutMs);
    }
  } catch (err) {
    status = "error";
    error = err.message;
    throw err;
  } finally {
    logEvent({ kind: "call", source, status, error, retried, latency_ms: Date.now() - start, model: MODEL, n_questions: Object.keys(questions).length });
  }
}
