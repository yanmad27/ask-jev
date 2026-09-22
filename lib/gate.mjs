import { readFileSync } from "node:fs";
import { apiKey } from "./jev.mjs";

const DEFAULT_GATES = "permission,stop,bash,prompt";

export const FOCUS = "Judge using the task, the conversation so far, the workspace state and the exact action; " +
  "the user's original ask is the ground truth for scope.";

/** Bật/tắt từng gate qua JEV_GATES (danh sách phẩy); rỗng = tắt hết. Không key = tắt hết. */
export function enabled(name) {
  if (!apiKey()) return false;
  const list = (process.env.JEV_GATES ?? DEFAULT_GATES).split(",").map((s) => s.trim());
  return list.includes(name);
}

export function tailText(s, n) {
  if (typeof s !== "string") return "";
  return s.split("\n").slice(-n).join("\n");
}

export function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}
